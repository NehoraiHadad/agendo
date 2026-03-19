import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { sendSessionControl } from '@/lib/realtime/worker-client';
import { enqueueSession } from '@/lib/worker/queue';
import { BadRequestError } from '@/lib/errors';
import { config } from '@/lib/config';
import type { AgendoControl } from '@/lib/realtime/events';

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');
    const { message, image, priority, clientId } = (await req.json()) as {
      message: string;
      image?: { mimeType: string; data: string };
      priority?: 'now' | 'next' | 'later';
      clientId?: string;
    };

    const session = await getSession(id);

    // 'ended' sessions can still cold-resume as long as a session_ref exists.
    const canResume = session.sessionRef !== null;
    if (
      !['active', 'awaiting_input', 'idle'].includes(session.status) &&
      !(session.status === 'ended' && canResume)
    ) {
      throw new BadRequestError(`Session not accepting messages (status: ${session.status})`);
    }

    // Cold resume: process has exited; restart via run-session job, passing the message in
    // job data (not writing to session.initialPrompt so the original prompt is preserved).
    if (session.status === 'idle' || session.status === 'ended') {
      // If an image was attached, save it to a predictable path for the session-runner to pick up.
      if (image) {
        const dir = join(config.LOG_DIR, 'attachments', id);
        mkdirSync(dir, { recursive: true });
        const imgPath = join(dir, 'resume-image');
        writeFileSync(imgPath, Buffer.from(image.data, 'base64'));
        writeFileSync(
          join(dir, 'resume-pending.json'),
          JSON.stringify({ path: imgPath, mimeType: image.mimeType }),
        );
      }
      await enqueueSession({
        sessionId: id,
        resumeRef: session.sessionRef ?? undefined,
        resumePrompt: message,
        resumeClientId: clientId,
        skipResumeContext: true,
      });
      return NextResponse.json({ data: { resuming: true } }, { status: 202 });
    }

    // Hot path: process is alive — forward message via Worker HTTP.
    // Images are saved to disk first; only the file path is sent through the control
    // channel to avoid large payloads.
    let imageRef: { path: string; mimeType: string } | undefined;
    if (image) {
      const dir = join(config.LOG_DIR, 'attachments', id);
      mkdirSync(dir, { recursive: true });
      const imgPath = join(dir, randomUUID());
      writeFileSync(imgPath, Buffer.from(image.data, 'base64'));
      imageRef = { path: imgPath, mimeType: image.mimeType };
    }

    const control: AgendoControl = {
      type: 'message',
      text: message,
      ...(imageRef && { imageRef }),
      ...(priority && { priority }),
      ...(clientId && { clientId }),
    };
    const result = await sendSessionControl(id, control);

    // If the worker doesn't have the process in memory (e.g. after a restart),
    // fall back to cold resume so the message isn't silently lost.
    if (!result.dispatched) {
      if (image && imageRef) {
        const dir = join(config.LOG_DIR, 'attachments', id);
        writeFileSync(
          join(dir, 'resume-pending.json'),
          JSON.stringify({ path: imageRef.path, mimeType: imageRef.mimeType }),
        );
      }
      await enqueueSession({
        sessionId: id,
        resumeRef: session.sessionRef ?? undefined,
        resumePrompt: message,
        resumeClientId: clientId,
        skipResumeContext: true,
      });
      return NextResponse.json({ data: { resuming: true } }, { status: 202 });
    }

    return NextResponse.json({ data: { delivered: true } }, { status: 202 });
  },
);
