import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { sendSessionControl } from '@/lib/realtime/worker-client';
import { BadRequestError } from '@/lib/errors';
import { getSession, restartFreshFromSession } from '@/lib/services/session-service';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { dispatchSession } from '@/lib/services/session-dispatch';
import type { AgendoControl } from '@/lib/realtime/events';
import type { Session } from '@/lib/types';

/**
 * POST /api/sessions/[id]/control
 *
 * Generic control channel endpoint. Publishes any AgendoControl payload to
 * the per-session PG NOTIFY channel. The session-process listener handles it.
 *
 * Special cases on idle/ended sessions (no active worker process):
 *   - allow: update permissionMode + initialPrompt, resume with existing sessionRef
 *   - clearContextRestart: create a fresh child session (Direction B)
 *
 * For clearContextRestart on active sessions: create the child session here so
 * the API can return newSessionId immediately, then pass newSessionIdForWorker
 * via PG NOTIFY so the worker enqueues it from onExit.
 */
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');
    const body = (await req.json()) as AgendoControl;

    // Only allow types that require simple PG NOTIFY relay (not the ones with
    // dedicated routes that do extra DB work, like 'message' and 'cancel').
    const allowedTypes = new Set([
      'tool-approval',
      'tool-result',
      'steer',
      'rollback',
      'mcp-set-servers',
      'mcp-reconnect',
      'mcp-toggle',
      'rewind-files',
      'cancel-queued',
    ]);
    if (!allowedTypes.has(body.type)) {
      throw new BadRequestError(`Control type '${body.type}' is not handled by this endpoint`);
    }

    // -----------------------------------------------------------------------
    // clearContextRestart (ExitPlanMode "Restart fresh"):
    //   Create a new child session (Direction B) so the old plan session stays
    //   intact and the new implementation session has a clean empty log.
    //   Handled here for ALL session states (idle AND active) so the API can
    //   return newSessionId immediately regardless.
    // -----------------------------------------------------------------------
    if (body.type === 'tool-approval' && body.clearContextRestart) {
      const session = await getSession(id);

      // Read plan file content.
      let planContent: string | null = null;
      if (session.planFilePath) {
        try {
          planContent = readFileSync(session.planFilePath, 'utf-8').trim() || null;
        } catch {
          planContent = null; // file may have been deleted
        }
      }

      const newMode = body.postApprovalMode ?? 'acceptEdits';
      const newSession = await restartFreshFromSession(id, planContent, newMode);

      if (session.status === 'idle' || session.status === 'ended') {
        // No active worker — enqueue the new session directly.
        await dispatchSession({ sessionId: newSession.id });
      } else {
        // Active session: relay to worker with the new session ID so it can
        // enqueue it from onExit after the process terminates cleanly.
        const result = await sendSessionControl(id, {
          ...body,
          newSessionIdForWorker: newSession.id,
        });
        // Worker process disappeared while DB status still says active/awaiting_input.
        // Fall back to starting the fresh child session directly instead of dropping
        // the approval on the floor and forcing the user to send a wake-up message.
        if (!result.dispatched) {
          await dispatchSession({ sessionId: newSession.id });
        }
      }

      return NextResponse.json(
        { data: { restarting: true, newSessionId: newSession.id } },
        { status: 202 },
      );
    }

    // -----------------------------------------------------------------------
    // tool-approval on idle/ended sessions: handle directly in the API route
    // since there is no worker process listening on the PG NOTIFY channel.
    // -----------------------------------------------------------------------
    if (body.type === 'tool-approval') {
      const session = await getSession(id);
      if (session.status === 'idle' || session.status === 'ended') {
        if (body.decision === 'allow') {
          await resumeApprovedPlanSession(id, session, body);

          return NextResponse.json({ data: { resuming: true } }, { status: 202 });
        }

        // deny on idle: user clicked "Revise" — they will send a message via
        // the /messages route which handles cold-resume independently.
      }
      // Session is active — fall through to worker relay. If the worker no
      // longer has a live process for this session, use the same cold-resume
      // fallback as the /message route.
      const result = await sendSessionControl(id, body);
      if (!result.dispatched && body.decision === 'allow') {
        await resumeApprovedPlanSession(id, session, body);
        return NextResponse.json({ data: { resuming: true } }, { status: 202 });
      }

      return NextResponse.json(
        { data: { delivered: result.dispatched === true } },
        { status: 202 },
      );
    }

    const result = await sendSessionControl(id, body);

    return NextResponse.json({ data: { delivered: result.dispatched === true } }, { status: 202 });
  },
);

async function resumeApprovedPlanSession(
  sessionId: string,
  session: Session,
  body: Extract<AgendoControl, { type: 'tool-approval' }>,
): Promise<void> {
  // Read plan file content.
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

  // Keep sessionRef intact so the worker resumes the existing Claude
  // conversation. ExitPlanMode is stripped from the transcript by the
  // CLI on resume, so it will not re-fire.
  const newMode = body.postApprovalMode ?? session.permissionMode;
  await db
    .update(sessions)
    .set({ permissionMode: newMode, initialPrompt })
    .where(eq(sessions.id, sessionId));

  await dispatchSession({
    sessionId,
    resumeRef: session.sessionRef ?? undefined,
    resumePrompt: initialPrompt,
  });
}
