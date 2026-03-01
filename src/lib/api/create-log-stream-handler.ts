import { NextRequest } from 'next/server';
import {
  openSync,
  readSync,
  closeSync,
  existsSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';

const STATUS_POLL_INTERVAL_MS = 1_000;
const FILE_POLL_INTERVAL_MS = 500;

export interface LogStreamConfig {
  terminalStatuses: Set<string>;
  notFoundMessage: string;
  getRecord(
    id: string,
  ): Promise<{ logFilePath: string | null; status: string; exitCode?: number | null } | null>;
  pollStatus(id: string): Promise<{ status: string; exitCode?: number | null } | null>;
}

/**
 * Creates an SSE response that streams a log file's content as it grows,
 * polling the record's status to detect when streaming should stop.
 *
 * Supports reconnect via the `Last-Event-ID` header (byte offset).
 */
export function createLogStreamHandler(
  req: NextRequest,
  id: string,
  config: LogStreamConfig,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let fileOffset = 0;
  let watcher: FSWatcher | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let filePollTimer: ReturnType<typeof setInterval> | null = null;

  const resumeOffset = parseInt(req.headers.get('last-event-id') ?? '0', 10) || 0;
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

      const record = await config.getRecord(id);
      if (!record) {
        send({ type: 'error', message: config.notFoundMessage });
        controller.close();
        return;
      }

      const logPath = record.logFilePath;
      const isTerminalNow = config.terminalStatuses.has(record.status);

      send({ type: 'status', status: record.status });

      if (resumeOffset === 0 && logPath && existsSync(logPath)) {
        const stat = statSync(logPath);
        if (stat.size > 0) {
          const fd = openSync(logPath, 'r');
          const buf = Buffer.alloc(stat.size);
          readSync(fd, buf, 0, stat.size, 0);
          closeSync(fd);
          send({ type: 'catchup', content: buf.toString('utf-8') }, stat.size);
          fileOffset = stat.size;
        }
      }

      if (isTerminalNow) {
        send({
          type: 'done',
          status: record.status,
          exitCode: record.exitCode ?? null,
        });
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
          const lines = buf.toString('utf-8').split('\n');
          for (const line of lines) {
            if (!line) continue;
            const match = line.match(/^\[(stdout|stderr|system|user)\] (.*)$/);
            if (match) {
              send({ type: 'log', content: match[2], stream: match[1] });
            } else {
              send({ type: 'log', content: line, stream: 'stdout' });
            }
          }
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
          const current = await config.pollStatus(id);
          if (!current) {
            send({ type: 'error', message: config.notFoundMessage });
            controller.close();
            cleanup();
            return;
          }
          send({ type: 'status', status: current.status });
          if (config.terminalStatuses.has(current.status)) {
            readNewBytes();
            send({ type: 'done', status: current.status, exitCode: current.exitCode ?? null });
            controller.close();
            cleanup();
          }
        } catch {
          // DB error — continue polling
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
