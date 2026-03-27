import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import {
  storeMessageAttachments,
  writePendingResumeAttachments,
} from '@/lib/services/session-attachment-service';
import { sendSessionControl } from '@/lib/realtime/worker-client';
import { dispatchSession } from '@/lib/services/session-dispatch';
import { BadRequestError } from '@/lib/errors';
import type { AgendoControl } from '@/lib/realtime/events';

interface ParsedMessageRequest {
  message: string;
  priority?: 'now' | 'next' | 'later';
  clientId?: string;
  attachments: Array<{
    name: string;
    mimeType?: string | null;
    data: Buffer;
  }>;
}

interface JsonAttachmentInput {
  name?: string;
  mimeType?: string;
  data: string;
}

function normalizeJsonAttachment(
  attachment: JsonAttachmentInput,
  fallbackName: string,
): ParsedMessageRequest['attachments'][number] {
  return {
    name: attachment.name?.trim() || fallbackName,
    mimeType: attachment.mimeType,
    data: Buffer.from(attachment.data, 'base64'),
  };
}

async function parseRequest(req: NextRequest): Promise<ParsedMessageRequest> {
  const contentType = req.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const message = String(form.get('message') ?? '');
    const priorityValue = form.get('priority');
    const clientIdValue = form.get('clientId');
    const attachments = await Promise.all(
      form
        .getAll('attachments')
        .filter((value): value is File => value instanceof File)
        .map(async (file) => ({
          name: file.name || 'attachment',
          mimeType: file.type || undefined,
          data: Buffer.from(await file.arrayBuffer()),
        })),
    );

    return {
      message,
      priority:
        priorityValue === 'now' || priorityValue === 'next' || priorityValue === 'later'
          ? priorityValue
          : undefined,
      clientId: typeof clientIdValue === 'string' && clientIdValue ? clientIdValue : undefined,
      attachments,
    };
  }

  const body = (await req.json()) as {
    message: string;
    image?: { mimeType: string; data: string };
    attachments?: JsonAttachmentInput[];
    priority?: 'now' | 'next' | 'later';
    clientId?: string;
  };

  const attachments = [
    ...(body.attachments ?? []).map((attachment, index) =>
      normalizeJsonAttachment(attachment, `attachment-${index + 1}`),
    ),
    ...(body.image ? [normalizeJsonAttachment(body.image, 'image')] : []),
  ];

  return {
    message: body.message,
    priority: body.priority,
    clientId: body.clientId,
    attachments,
  };
}

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');
    const {
      message,
      priority,
      clientId,
      attachments: incomingAttachments,
    } = await parseRequest(req);

    const session = await getSession(id);

    // 'ended' sessions can still cold-resume as long as a session_ref exists.
    const canResume = session.sessionRef !== null;
    if (
      !['active', 'awaiting_input', 'idle'].includes(session.status) &&
      !(session.status === 'ended' && canResume)
    ) {
      throw new BadRequestError(`Session not accepting messages (status: ${session.status})`);
    }

    const attachments = await storeMessageAttachments(id, incomingAttachments);

    // Cold resume: process has exited; restart via run-session job, passing the message in
    // job data (not writing to session.initialPrompt so the original prompt is preserved).
    if (session.status === 'idle' || session.status === 'ended') {
      if (attachments.length > 0) writePendingResumeAttachments(id, attachments);
      await dispatchSession({
        sessionId: id,
        resumeRef: session.sessionRef ?? undefined,
        resumePrompt: message,
        resumeClientId: clientId,
        skipResumeContext: true,
      });
      return NextResponse.json({ data: { resuming: true } }, { status: 202 });
    }

    // Hot path: process is alive — forward message via Worker HTTP.
    const control: AgendoControl = {
      type: 'message',
      text: message,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(priority && { priority }),
      ...(clientId && { clientId }),
    };
    const result = await sendSessionControl(id, control);

    // If the worker doesn't have the process in memory (e.g. after a restart),
    // fall back to cold resume so the message isn't silently lost.
    if (!result.dispatched) {
      if (attachments.length > 0) writePendingResumeAttachments(id, attachments);
      await dispatchSession({
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
