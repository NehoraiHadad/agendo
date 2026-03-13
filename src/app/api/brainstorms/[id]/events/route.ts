import { NextRequest } from 'next/server';
import { subscribe, channelName } from '@/lib/realtime/pg-notify';
import { getBrainstorm, getMessages } from '@/lib/services/brainstorm-service';
import { assertUUID } from '@/lib/api-handler';
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

      // Phase 2: replay ALL stored messages on every connection.
      // PG NOTIFY has no replay buffer — events published while the client was
      // disconnected are permanently lost. We always replay from the DB so
      // reconnecting clients get full history. The Zustand store deduplicates
      // by event id on the client side.
      try {
        // Build agentId → agentName lookup from participants
        const agentNameMap = new Map<string, string>();
        for (const p of room.participants) {
          agentNameMap.set(p.agentId, p.agentName);
        }

        const historicalMessages = await getMessages(id);
        for (let i = 0; i < historicalMessages.length; i++) {
          const msg = historicalMessages[i];
          const replayEvent: BrainstormEvent = {
            id: i + 1,
            roomId: id,
            ts: msg.createdAt.getTime(),
            type: 'message',
            wave: msg.wave,
            senderType: msg.senderType as 'agent' | 'user',
            agentId: msg.senderAgentId ?? undefined,
            agentName: msg.senderAgentId ? agentNameMap.get(msg.senderAgentId) : undefined,
            content: msg.content,
            isPass: msg.isPass,
          };
          send(replayEvent);
        }
      } catch {
        // Historical replay failed — continue with live stream only
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
