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
 * Special cases on idle/ended sessions (no active worker process):
 *   - allow: update permissionMode + initialPrompt, resume with existing sessionRef
 *   - clearContextRestart: clear sessionRef so re-enqueue spawns fresh
 *
 * Both paths use the plan file content as the initialPrompt so Claude is
 * explicitly told to implement the plan on the next run.
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
    // tool-approval on idle/ended sessions: handle directly in the API route
    // since there is no worker process listening on the PG NOTIFY channel.
    // -----------------------------------------------------------------------
    if (body.type === 'tool-approval') {
      const session = await getSession(id);
      if (session.status === 'idle' || session.status === 'ended') {
        // Read plan file content — shared by both allow and clearContextRestart.
        let planContent: string | null = null;
        if (session.planFilePath) {
          try {
            planContent = readFileSync(session.planFilePath, 'utf-8').trim() || null;
          } catch {
            planContent = null; // file may have been deleted
          }
        }
        const initialPrompt = planContent
          ? `Implement the following plan:\n\n${planContent}`
          : 'Continue implementing the plan from the previous conversation.';

        if (body.clearContextRestart) {
          // ── Option: clear context + restart fresh ──────────────────────
          // Clear sessionRef so the worker spawns a new Claude process (no --resume).
          const newMode = body.postApprovalMode ?? 'acceptEdits';
          await db
            .update(sessions)
            .set({ sessionRef: null, initialPrompt, permissionMode: newMode })
            .where(eq(sessions.id, id));

          await enqueueSession({ sessionId: id });

          return NextResponse.json({ data: { restarting: true } }, { status: 202 });
        }

        if (body.decision === 'allow') {
          // ── Option: allow in-place (keep context, resume with --resume) ─
          // Keep sessionRef intact so the worker resumes the existing Claude
          // conversation. ExitPlanMode is stripped from the transcript by the
          // CLI on resume (NO$() removes unresolved tool_uses), so it will NOT
          // re-fire. Claude simply continues from where it left off with the
          // initialPrompt as the first user message.
          const newMode = body.postApprovalMode ?? session.permissionMode;
          await db
            .update(sessions)
            .set({ permissionMode: newMode, initialPrompt })
            .where(eq(sessions.id, id));

          await enqueueSession({ sessionId: id, resumeRef: session.sessionRef ?? undefined });

          return NextResponse.json({ data: { resuming: true } }, { status: 202 });
        }

        // deny on idle: user clicked "Revise" — they will send a message via
        // the /messages route which handles cold-resume independently.
      }
      // Session is active — fall through to PG NOTIFY relay for the worker.
    }

    await publish(channelName('agendo_control', id), body);

    return NextResponse.json({ data: { delivered: true } }, { status: 202 });
  },
);
