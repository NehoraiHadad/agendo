import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { config } from '@/lib/config';

const DB_FLUSH_INTERVAL_MS = 5_000;

export interface LogWriterStats {
  byteSize: number;
  lineCount: number;
}

export class FileLogWriter {
  private stream: WriteStream | null = null;
  private byteSize = 0;
  private lineCount = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private closed = false;

  constructor(
    private readonly executionId: string | null,
    private readonly logFilePath: string,
  ) {}

  open(): void {
    mkdirSync(dirname(this.logFilePath), { recursive: true });
    this.stream = createWriteStream(this.logFilePath, { flags: 'a' });
    this.flushTimer = setInterval(() => {
      if (this.dirty) {
        void this.flushToDb();
      }
    }, DB_FLUSH_INTERVAL_MS);
  }

  write(chunk: string, stream: 'stdout' | 'stderr' | 'system' | 'user' = 'stdout'): void {
    if (this.closed || !this.stream) return;
    const prefixed = chunk
      .split('\n')
      .map((line) => (line ? `[${stream}] ${line}` : ''))
      .join('\n');
    const buf = Buffer.from(prefixed, 'utf-8');
    this.stream.write(buf);
    this.byteSize += buf.byteLength;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === '\n') this.lineCount++;
    }
    this.dirty = true;
  }

  writeSystem(message: string): void {
    this.write(`${message}\n`, 'system');
  }

  writeEvent(event: { id: number; type: string; [key: string]: unknown }): void {
    if (this.closed || !this.stream) return;
    const line = `[${event.id}|${event.type}] ${JSON.stringify(event)}\n`;
    const buf = Buffer.from(line, 'utf-8');
    this.stream.write(buf);
    this.byteSize += buf.byteLength;
    this.lineCount++;
    this.dirty = true;
  }

  async close(): Promise<LogWriterStats> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushToDb();
    if (this.stream) {
      const s = this.stream;
      await new Promise<void>((resolve) => {
        s.end(resolve);
      });
      this.stream = null;
    }
    return { byteSize: this.byteSize, lineCount: this.lineCount };
  }

  get stats(): LogWriterStats {
    return { byteSize: this.byteSize, lineCount: this.lineCount };
  }

  private async flushToDb(): Promise<void> {
    if (!this.executionId) return; // Sessions don't need byte/line stats in DB
    this.dirty = false;
    await db
      .update(executions)
      .set({
        logByteSize: this.byteSize,
        logLineCount: this.lineCount,
        logUpdatedAt: new Date(),
      })
      .where(eq(executions.id, this.executionId));
  }
}

export function resolveLogPath(executionId: string): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  return join(config.LOG_DIR, yyyy, mm, `${executionId}.log`);
}

export function resolveSessionLogPath(sessionId: string): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  return join(config.LOG_DIR, yyyy, mm, `session-${sessionId}.log`);
}
