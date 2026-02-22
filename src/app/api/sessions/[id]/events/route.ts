import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { subscribe, channelName, publish } from '@/lib/realtime/pg-notify';
import { readEventsFromLog } from '@/lib/realtime/events';
import type { AgendoEvent, AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';
import { withErrorBoundary } from '@/lib/api-handler';

function makeSessionStateEvent(session: { id: string; status: string; eventSeq: number }): AgendoEvent {
  return {
    id: 0, // synthetic event, not counted in seq
    sessionId: session.id,
    ts: Date.now(),
    type: 'session:state',
    status: session.status as SessionStatus,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const lastEventId = parseInt(req.headers.get('last-event-id') ?? '0', 10) || 0;

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);

  if (!session) {
    return new Response('Session not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: AgendoEvent) {
        try {
          controller.enqueue(
            encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Client disconnected
        }
      }

      // 1. Emit current session state immediately
      send(makeSessionStateEvent(session));

      // 2. Catchup: read session log file for events after lastEventId
      if (session.logFilePath && existsSync(session.logFilePath)) {
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
        unsubscribe = await subscribe(
          channelName('agendo_events', id),
          (payload) => {
            try {
              const ev = JSON.parse(payload) as AgendoEvent;
              send(ev);
            } catch {
              // Invalid payload — ignore
            }
          },
        );
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

    // Verify session exists
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);

    if (!session) {
      return new NextResponse('Session not found', { status: 404 });
    }

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
