import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { tasks, executions } from '@/lib/db/schema';
import { sql } from 'drizzle-orm';
import { listTasksBoardItems } from '@/lib/services/task-service';

const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 15000;

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const encoder = new TextEncoder();
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let lastPoll = new Date();

      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      }

      // Send initial snapshot with subtask counts
      try {
        const allTasks = await listTasksBoardItems([]);
        send('snapshot', { tasks: allTasks });
      } catch (err) {
        console.error('SSE snapshot error:', err);
        send('error', { message: 'Failed to load snapshot' });
      }

      // Poll for changes
      pollTimer = setInterval(async () => {
        if (closed) {
          if (pollTimer) clearInterval(pollTimer);
          return;
        }

        try {
          const updatedTasks = await listTasksBoardItems([
            sql`${tasks.updatedAt} > ${lastPoll}`,
          ]);

          for (const task of updatedTasks) {
            send('task_updated', task);
          }

          const updatedExecs = await db
            .select()
            .from(executions)
            .where(
              sql`${executions.createdAt} > ${lastPoll} OR ${executions.startedAt} > ${lastPoll} OR ${executions.endedAt} > ${lastPoll}`,
            );

          for (const exec of updatedExecs) {
            send('execution_status', {
              id: exec.id,
              taskId: exec.taskId,
              status: exec.status,
            });
          }

          lastPoll = new Date();
        } catch (err) {
          console.error('SSE poll error:', err);
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

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
