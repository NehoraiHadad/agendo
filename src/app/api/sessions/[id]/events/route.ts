import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { subscribe, channelName, publish } from '@/lib/realtime/pg-notify';
import { readEventsFromLog } from '@/lib/realtime/events';
import { mapSessionMessagesToEvents } from '@/lib/realtime/session-message-mapper';
import type { AgendoEvent, AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';

function makeSessionStateEvent(session: {
  id: string;
  status: string;
  eventSeq: number;
}): AgendoEvent {
  return {
    id: 0, // synthetic event, not counted in seq
    sessionId: session.id,
    ts: Date.now(),
    type: 'session:state',
    status: session.status as SessionStatus,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    assertUUID(id, 'Session');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  // On browser-auto-reconnect the Last-Event-ID header is set; on client-triggered
  // reconnect (new EventSource instance) it isn't, so fall back to the query param.
  const lastEventId =
    parseInt(
      req.headers.get('last-event-id') ?? req.nextUrl.searchParams.get('lastEventId') ?? '0',
      10,
    ) || 0;

  let session;
  try {
    session = await getSession(id);
  } catch {
    return new Response('Session not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: AgendoEvent) {
        try {
          controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected
        }
      }

      // 1. Emit current session state immediately
      send(makeSessionStateEvent(session));

      // 2. Catchup: replay historical events after lastEventId.
      //
      // For Claude sessions (sessionRef set): call getSessionMessages() to read
      // directly from Claude's authoritative JSONL transcript. This avoids the
      // fake-NDJSON serialize→write→read→parse round-trip and works even when the
      // agendo log file is missing or corrupted.
      //
      // For non-Claude sessions (Codex, Gemini) and as a fallback: read the
      // agendo log file as before.
      let catchupDone = false;

      if (session.sessionRef) {
        try {
          const sdkMessages = await getSessionMessages(session.sessionRef);
          const catchupEvents = mapSessionMessagesToEvents(sdkMessages, id, lastEventId);
          for (const ev of catchupEvents) {
            send(ev);
          }
          catchupDone = true;
        } catch {
          // SDK call failed (session not found on disk, etc.) — fall back to log file
        }
      }

      if (!catchupDone && session.logFilePath && existsSync(session.logFilePath)) {
        try {
          const logContent = readFileSync(session.logFilePath, 'utf-8');
          const catchupEvents = readEventsFromLog(logContent, lastEventId);
          for (const ev of catchupEvents) {
            send(ev);
          }
        } catch {
          // Log file unreadable — skip catchup
        }
      }

      // 3. Subscribe to live events via PG NOTIFY
      try {
        unsubscribe = await subscribe(channelName('agendo_events', id), (payload) => {
          try {
            const ev = JSON.parse(payload) as AgendoEvent;
            send(ev);
          } catch {
            // Invalid payload — ignore
          }
        });
      } catch {
        // PG subscribe failed — close stream
        controller.close();
      }
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * POST /api/sessions/:id/events
 *
 * Accepts an event payload and broadcasts it to all SSE subscribers via PG NOTIFY.
 */
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    // Verify session exists (throws NotFoundError if not)
    await getSession(id);

    const body = (await req.json()) as Record<string, unknown>;

    // Publish to the session's PG NOTIFY channel so all SSE subscribers receive it
    const event: AgendoEvent = {
      id: 0, // synthetic — not counted in sequence
      sessionId: id,
      ts: Date.now(),
      ...(body as AgendoEventPayload),
    };

    await publish(channelName('agendo_events', id), event);

    return new NextResponse(null, { status: 204 });
  },
);
