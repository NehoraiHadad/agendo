import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serializeEvent, type AgendoEvent } from '@/lib/realtime/events';
import { resolveSessionLogPath } from '@/lib/worker/log-writer';

/**
 * Write converted AgendoEvents to a session log file.
 * Uses the same format as FileLogWriter.writeEvent so SSE catchup works.
 */
export function writeImportedLog(sessionId: string, events: AgendoEvent[]): string {
  const logPath = resolveSessionLogPath(sessionId);
  mkdirSync(dirname(logPath), { recursive: true });

  const content = events.map((e) => `[system] ${serializeEvent(e)}`).join('');
  writeFileSync(logPath, content, 'utf-8');

  return logPath;
}
