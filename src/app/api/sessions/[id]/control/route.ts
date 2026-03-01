import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { BadRequestError } from '@/lib/errors';
import { getSession } from '@/lib/services/session-service';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueSession } from '@/lib/worker/queue';
import type { AgendoControl } from '@/lib/realtime/events';

/**
 * POST /api/sessions/[id]/control
 *
 * Generic control channel endpoint. Publishes any AgendoControl payload to
 * the per-session PG NOTIFY channel. The session-process listener handles it.
 *
 * Special case: clearContextRestart on idle/ended sessions is handled directly
 * (no active worker process needed) — updates DB and re-enqueues.
 */
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = (await req.json()) as AgendoControl;

    // Only allow types that require simple PG NOTIFY relay (not the ones with
    // dedicated routes that do extra DB work, like 'message' and 'cancel').
    const allowedTypes = new Set(['tool-approval', 'tool-result', 'answer-question']);
    if (!allowedTypes.has(body.type)) {
      throw new BadRequestError(`Control type '${body.type}' is not handled by this endpoint`);
    }

    // -----------------------------------------------------------------------
    // clearContextRestart on idle/ended sessions: handle directly in the API
    // route since there is no worker process listening on the PG NOTIFY channel.
    // -----------------------------------------------------------------------
    if (body.type === 'tool-approval' && body.clearContextRestart) {
      const session = await getSession(id);
      if (session.status === 'idle' || session.status === 'ended') {
        // Read plan content from the stored plan_file_path in the DB
        let planContent: string | null = null;
        if (session.planFilePath) {
          try {
            planContent = readFileSync(session.planFilePath, 'utf-8').trim() || null;
          } catch {
            planContent = null; // file may have been deleted
          }
        }

        const newMode = body.postApprovalMode ?? 'acceptEdits';
        const initialPrompt = planContent
          ? `Implement the following plan:\n\n${planContent}`
          : 'Continue implementing the plan from the previous conversation.';

        await db
          .update(sessions)
          .set({ sessionRef: null, initialPrompt, permissionMode: newMode })
          .where(eq(sessions.id, id));

        await enqueueSession({ sessionId: id });

        return NextResponse.json({ data: { restarting: true } }, { status: 202 });
      }
      // Session is active — fall through to PG NOTIFY relay for the worker.
    }

    await publish(channelName('agendo_control', id), body);

    return NextResponse.json({ data: { delivered: true } }, { status: 202 });
  },
);
