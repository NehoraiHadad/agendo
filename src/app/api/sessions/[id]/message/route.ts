import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { enqueueSession } from '@/lib/worker/queue';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { BadRequestError } from '@/lib/errors';
import { config } from '@/lib/config';
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
      throw new BadRequestError(`Session not accepting messages (status: ${session.status})`);
    }

    // Cold resume: process has exited; update initialPrompt and restart via run-session job.
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
    // Images are saved to disk first; only the file path is sent through PG NOTIFY
    // to avoid exceeding the 7500-byte payload limit (a base64 image is far larger).
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
    };
    await publish(channelName('agendo_control', id), control);

    return NextResponse.json({ data: { delivered: true } }, { status: 202 });
  },
);
