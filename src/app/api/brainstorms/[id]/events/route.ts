import { readFileSync, existsSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { subscribe, channelName } from '@/lib/realtime/pg-notify';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { assertUUID } from '@/lib/api-handler';
import { readBrainstormEventsFromLog } from '@/lib/realtime/event-utils';
import type { BrainstormEvent, BrainstormRoomStatus } from '@/lib/realtime/event-types';

/**
 * Synthetic room:state event emitted at connection time so the client has
 * an immediate view of the room before replaying historical messages.
 */
function makeRoomStateEvent(room: { id: string; status: string }): BrainstormEvent {
  return {
    id: 0,
    roomId: room.id,
    ts: Date.now(),
    type: 'room:state',
    status: room.status as BrainstormRoomStatus,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    assertUUID(id, 'BrainstormRoom');
  } catch {
    return new Response('Not found', { status: 404 });
  }

  let room;
  try {
    room = await getBrainstorm(id);
  } catch {
    return new Response('BrainstormRoom not found', { status: 404 });
  }

  // Parse lastEventId from query params — used to skip already-seen events on reconnect
  const url = new URL(req.url);
  const lastEventIdParam = url.searchParams.get('lastEventId');
  const lastEventId = lastEventIdParam ? parseInt(lastEventIdParam, 10) : 0;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      /**
       * Encode and enqueue an SSE frame.
       * Format: `id: {id}\ndata: {json}\n\n`
       */
      function send(event: BrainstormEvent) {
        try {
          controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected — ignore write error
        }
      }

      // Phase 1: emit current room state immediately
      send(makeRoomStateEvent(room));

      // Phase 1.5: emit synthetic participant:status events so reconnecting clients
      // see accurate participant states rather than defaulting to 'active'.
      // DB status ('pending'|'active'|'passed'|'left') maps to event status:
      //   active  → 'thinking' (participant is live / mid-wave)
      //   passed  → 'passed'   (participant has passed their turn)
      //   pending / left — no meaningful wave status; skip
      for (const p of room.participants) {
        let eventStatus: 'thinking' | 'done' | 'passed' | 'timeout' | null = null;
        if (p.status === 'active') eventStatus = 'thinking';
        else if (p.status === 'passed') eventStatus = 'passed';

        if (eventStatus !== null) {
          send({
            id: 0,
            roomId: id,
            ts: Date.now(),
            type: 'participant:status',
            agentId: p.agentId,
            agentName: p.agentName,
            status: eventStatus,
          });
        }
      }

      // Phase 2: replay historical events from the log file after lastEventId.
      // PG NOTIFY has no replay buffer — events published while the client was
      // disconnected are permanently lost. The log file acts as the durable
      // replay store for reconnecting clients.
      if (room.logFilePath && existsSync(room.logFilePath)) {
        try {
          const logContent = readFileSync(room.logFilePath, 'utf-8');
          const catchupEvents = readBrainstormEventsFromLog(logContent, lastEventId);
          for (const ev of catchupEvents) {
            send(ev);
          }
        } catch {
          // Log file unreadable — skip catchup, continue with live stream
        }
      }

      // Phase 3: subscribe to live events via PG NOTIFY
      try {
        unsubscribe = await subscribe(channelName('brainstorm_events', id), (payload) => {
          try {
            const ev = JSON.parse(payload) as BrainstormEvent;
            send(ev);
          } catch {
            // Malformed payload — ignore
          }
        });
      } catch {
        // PG LISTEN failed — close the stream so the client can retry
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
