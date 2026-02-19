import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { enqueueSession } from '@/lib/worker/queue';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { BadRequestError } from '@/lib/errors';
import type { AgendoControl } from '@/lib/realtime/events';

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const { message, image } = (await req.json()) as {
      message: string;
      image?: { mimeType: string; data: string };
    };

    const session = await getSession(id);

    // 'ended' sessions can still cold-resume as long as a session_ref exists.
    const canResume = session.sessionRef !== null;
    if (
      !['active', 'awaiting_input', 'idle'].includes(session.status) &&
      !(session.status === 'ended' && canResume)
    ) {
      throw new BadRequestError(
        `Session not accepting messages (status: ${session.status})`,
      );
    }

    // Cold resume: process has exited; update initialPrompt and restart via run-session job.
    if (session.status === 'idle' || session.status === 'ended') {
      await db
        .update(sessions)
        .set({
          initialPrompt: message, // runner will use this as the resume prompt
        })
        .where(eq(sessions.id, id));
      await enqueueSession({
        sessionId: id,
        resumeRef: session.sessionRef ?? undefined,
      });
      return NextResponse.json({ data: { resuming: true } }, { status: 202 });
    }

    // Hot path: process is alive — forward message via PG NOTIFY.
    const control: AgendoControl = { type: 'message', text: message, ...(image && { image }) };
    await publish(channelName('agendo_control', id), control);

    return NextResponse.json({ data: { delivered: true } }, { status: 202 });
  },
);
