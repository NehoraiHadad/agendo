/**
 * Session history service — paginated event history from log files.
 *
 * Provides REST-friendly access to session event history with cursor-based
 * pagination, designed for:
 *   - Loading older messages on scroll-back
 *   - Initial history load without full SSE replay
 *   - Exporting/debugging session history
 */

import { existsSync, readFileSync } from 'node:fs';
import { NotFoundError } from '@/lib/errors';
import { getSessionLogInfo } from '@/lib/services/session-service';
import {
  readPaginatedEventsFromLog,
  type PaginatedEventsResult,
  type PaginatedEventsOptions,
} from '@/lib/realtime/event-utils';

export interface SessionHistoryResult extends PaginatedEventsResult {
  /** Session ID */
  sessionId: string;
}

/**
 * Get paginated event history for a session from its log file.
 *
 * @param sessionId UUID of the session
 * @param options   Cursor-based pagination options
 * @returns Paginated events with cursor metadata
 * @throws NotFoundError if the session doesn't exist
 */
export async function getSessionHistory(
  sessionId: string,
  options: PaginatedEventsOptions,
): Promise<SessionHistoryResult> {
  const logInfo = await getSessionLogInfo(sessionId);
  if (!logInfo) {
    throw new NotFoundError('Session', sessionId);
  }

  const empty: SessionHistoryResult = {
    sessionId,
    events: [],
    hasMore: false,
    totalCount: 0,
    oldestSeq: null,
    newestSeq: null,
  };

  if (!logInfo.logFilePath || !existsSync(logInfo.logFilePath)) {
    return empty;
  }

  const logContent = readFileSync(logInfo.logFilePath, 'utf-8');
  const result = readPaginatedEventsFromLog(logContent, options);

  return {
    sessionId,
    ...result,
  };
}
