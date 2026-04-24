import { NextRequest } from 'next/server';
import { tasks } from '@/lib/db/schema';
import { sql } from 'drizzle-orm';
import { listTasksBoardItems } from '@/lib/services/task-service';
import { createLogger } from '@/lib/logger';
import { SSE_HEADERS } from '@/lib/sse/constants';
import { encodeNamedSSE } from '@/lib/sse/encoder';
import { isDemoMode } from '@/lib/demo/flag';
import { replayEventsAsSSE } from '@/lib/demo/sse/replay';
import { generateBoardUpdates } from '@/lib/demo/fixtures/board-updates';
import type { ReplayableEvent } from '@/lib/demo/sse/replay';

const log = createLogger('sse-board');
const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 15000;

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  // -------------------------------------------------------------------------
  // Demo mode: replay pre-generated board updates instead of polling DB
  // -------------------------------------------------------------------------
  if (isDemoMode()) {
    const boardEvents = generateBoardUpdates({ count: 50, intervalMs: 8000 });

    // Convert BoardUpdateEvent[] to ReplayableEvent[] — the type field comes
    // from the payload's own `type` discriminant.
    const replayable: ReplayableEvent[] = boardEvents.map((e) => ({
      atMs: e.atMs,
      type: e.payload.type,
      payload: e.payload,
    }));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = replayEventsAsSSE(replayable, controller, {
          signal: _req.signal,
          speed: 1.0,
        });
        _req.signal.addEventListener('abort', cleanup, { once: true });
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  // -------------------------------------------------------------------------
  // Production: poll DB for real task updates
  // -------------------------------------------------------------------------
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let lastPoll = new Date();

      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encodeNamedSSE(event, data));
        } catch {
          closed = true;
        }
      }

      // Send initial snapshot with subtask counts
      try {
        const allTasks = await listTasksBoardItems([]);
        send('snapshot', { tasks: allTasks });
      } catch (err) {
        log.error({ err }, 'SSE snapshot error');
        send('error', { message: 'Failed to load snapshot' });
      }

      // Poll for changes
      pollTimer = setInterval(async () => {
        if (closed) {
          if (pollTimer) clearInterval(pollTimer);
          return;
        }

        try {
          const updatedTasks = await listTasksBoardItems([sql`${tasks.updatedAt} > ${lastPoll}`]);

          for (const task of updatedTasks) {
            send('task_updated', task);
          }

          lastPoll = new Date();
        } catch (err) {
          log.error({ err }, 'SSE poll error');
        }
      }, POLL_INTERVAL_MS);

      // Heartbeat
      heartbeatTimer = setInterval(() => {
        if (closed) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          return;
        }
        send('heartbeat', { ts: Date.now() });
      }, HEARTBEAT_INTERVAL_MS);
    },

    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
