import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { createExecution } from '@/lib/services/execution-service';
import { enqueueExecution } from '@/lib/worker/queue';
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
    if (!['active', 'awaiting_input', 'idle'].includes(session.status) &&
        !(session.status === 'ended' && canResume)) {
      throw new BadRequestError(
        `Session not accepting messages (status: ${session.status})`,
      );
    }

    // Cold resume: process has exited; restart via a new execution carrying the
    // user's message as promptOverride so the agent sees it as its new prompt.
    if (session.status === 'idle' || session.status === 'ended') {
      const execution = await createExecution({
        taskId: session.taskId,
        agentId: session.agentId,
        capabilityId: session.capabilityId,
        promptOverride: message,
        sessionId: id,
        sessionRef: session.sessionRef ?? undefined,
      });
      await enqueueExecution({
        executionId: execution.id,
        capabilityId: session.capabilityId,
        agentId: session.agentId,
        args: execution.args,
        sessionId: id,
      });
      return NextResponse.json({ data: { resuming: true } }, { status: 202 });
    }

    // Hot path: process is alive — forward message via PG NOTIFY.
    const control: AgendoControl = { type: 'message', text: message, ...(image && { image }) };
    await publish(channelName('agendo_control', id), control);

    return NextResponse.json({ data: { delivered: true } }, { status: 202 });
  },
);
