import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  openSync,
  readSync,
  closeSync,
  existsSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const STATUS_POLL_INTERVAL_MS = 1_000;
const FILE_POLL_INTERVAL_MS = 500;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<Record<string, string>> },
) {
  const { id } = await params;
  const encoder = new TextEncoder();
  let closed = false;
  let fileOffset = 0;
  let watcher: FSWatcher | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let filePollTimer: ReturnType<typeof setInterval> | null = null;

  const resumeOffset = parseInt(_req.headers.get('last-event-id') ?? '0', 10) || 0;
  fileOffset = resumeOffset;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: Record<string, unknown>, eventId?: number) {
        if (closed) return;
        try {
          const idLine = eventId !== undefined ? `id: ${eventId}\n` : '';
          controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      }

      function cleanup() {
        closed = true;
        if (watcher) {
          watcher.close();
          watcher = null;
        }
        if (statusTimer) {
          clearInterval(statusTimer);
          statusTimer = null;
        }
        if (filePollTimer) {
          clearInterval(filePollTimer);
          filePollTimer = null;
        }
      }

      const [execution] = await db.select().from(executions).where(eq(executions.id, id)).limit(1);
      if (!execution) {
        send({ type: 'error', message: `Execution ${id} not found` });
        controller.close();
        return;
      }

      send({ type: 'status', status: execution.status });

      const logPath = execution.logFilePath;
      if (resumeOffset === 0 && logPath && existsSync(logPath)) {
        const stat = statSync(logPath);
        if (stat.size > 0) {
          const fd = openSync(logPath, 'r');
          const buf = Buffer.alloc(stat.size);
          readSync(fd, buf, 0, stat.size, 0);
          closeSync(fd);
          const content = buf.toString('utf-8');
          send({ type: 'catchup', content }, stat.size);
          fileOffset = stat.size;
        }
      }

      if (TERMINAL_STATUSES.has(execution.status)) {
        send({ type: 'done', status: execution.status, exitCode: execution.exitCode });
        controller.close();
        cleanup();
        return;
      }

      function readNewBytes() {
        if (closed || !logPath) return;
        try {
          if (!existsSync(logPath)) return;
          const stat = statSync(logPath);
          if (stat.size <= fileOffset) return;
          const fd = openSync(logPath, 'r');
          const buf = Buffer.alloc(stat.size - fileOffset);
          readSync(fd, buf, 0, buf.length, fileOffset);
          closeSync(fd);
          fileOffset = stat.size;
          const content = buf.toString('utf-8');
          const lines = content.split('\n');
          for (const line of lines) {
            if (!line) continue;
            const match = line.match(/^\[(stdout|stderr|system)\] (.*)$/);
            if (match) {
              send({ type: 'log', content: match[2], stream: match[1] });
            } else {
              send({ type: 'log', content: line, stream: 'stdout' });
            }
          }

          // Emit current byte offset as SSE event id for reconnect support
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(`id: ${fileOffset}\n\n`));
            } catch {
              closed = true;
            }
          }
        } catch {
          // File may have been deleted or rotated
        }
      }

      if (logPath && existsSync(logPath)) {
        try {
          watcher = watch(logPath, () => readNewBytes());
        } catch {
          // fs.watch may fail on some filesystems
        }
      }

      filePollTimer = setInterval(() => {
        if (!logPath) return;
        if (!watcher && existsSync(logPath)) {
          try {
            watcher = watch(logPath, () => readNewBytes());
          } catch {
            /* noop */
          }
        }
        readNewBytes();
      }, FILE_POLL_INTERVAL_MS);

      statusTimer = setInterval(async () => {
        if (closed) return;
        try {
          const [current] = await db
            .select({ status: executions.status, exitCode: executions.exitCode })
            .from(executions)
            .where(eq(executions.id, id))
            .limit(1);
          if (!current) {
            send({ type: 'error', message: 'Execution not found' });
            controller.close();
            cleanup();
            return;
          }
          send({ type: 'status', status: current.status });
          if (TERMINAL_STATUSES.has(current.status)) {
            readNewBytes();
            send({ type: 'done', status: current.status, exitCode: current.exitCode });
            controller.close();
            cleanup();
          }
        } catch {
          // DB error -- continue polling
        }
      }, STATUS_POLL_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      if (filePollTimer) {
        clearInterval(filePollTimer);
        filePollTimer = null;
      }
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
