/**
 * Tests for session-history-service — paginated session event history
 *
 * Tests `getSessionHistory()` which reads events from session log files
 * with cursor-based pagination.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgendoEvent } from '@/lib/realtime/events';
import { serializeEvent } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Mock: session-service (getSessionLogPath)
// ---------------------------------------------------------------------------

const mockGetSessionLogInfo = vi.fn();

vi.mock('@/lib/services/session-service', () => ({
  getSessionLogInfo: (...args: unknown[]) => mockGetSessionLogInfo(...args),
}));

// ---------------------------------------------------------------------------
// Mock: node:fs
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

const { getSessionHistory } = await import('../session-history-service');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const baseEvent = {
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  ts: 1700000000000,
};

function buildLogContent(events: AgendoEvent[]): string {
  return events.map((e) => `[system] ${serializeEvent(e)}`).join('');
}

function makeEvents(count: number): AgendoEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    ...baseEvent,
    id: i + 1,
    type: 'agent:text' as const,
    text: `message-${i + 1}`,
  }));
}

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getSessionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionLogInfo.mockResolvedValue({
      logFilePath: '/data/logs/2026/03/session-test.log',
      status: 'ended',
    });
    mockExistsSync.mockReturnValue(true);
  });

  it('returns paginated events from the log file', async () => {
    const events = makeEvents(20);
    mockReadFileSync.mockReturnValue(buildLogContent(events));

    const result = await getSessionHistory(SESSION_ID, { limit: 5 });

    expect(result.events).toHaveLength(5);
    expect(result.events[0].id).toBe(16);
    expect(result.events[4].id).toBe(20);
    expect(result.hasMore).toBe(true);
    expect(result.totalCount).toBe(20);
  });

  it('returns older events using beforeSeq cursor', async () => {
    const events = makeEvents(20);
    mockReadFileSync.mockReturnValue(buildLogContent(events));

    const result = await getSessionHistory(SESSION_ID, { beforeSeq: 16, limit: 5 });

    expect(result.events).toHaveLength(5);
    expect(result.events[0].id).toBe(11);
    expect(result.events[4].id).toBe(15);
    expect(result.hasMore).toBe(true);
  });

  it('returns empty result when log file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await getSessionHistory(SESSION_ID, { limit: 10 });

    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.totalCount).toBe(0);
  });

  it('returns empty result when session has no logFilePath', async () => {
    mockGetSessionLogInfo.mockResolvedValue({
      logFilePath: null,
      status: 'ended',
    });

    const result = await getSessionHistory(SESSION_ID, { limit: 10 });

    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('throws NotFoundError when session does not exist', async () => {
    mockGetSessionLogInfo.mockResolvedValue(null);

    await expect(getSessionHistory(SESSION_ID, {})).rejects.toThrow(/Session.*not found/);
  });

  it('returns all events when no limit is specified', async () => {
    const events = makeEvents(10);
    mockReadFileSync.mockReturnValue(buildLogContent(events));

    const result = await getSessionHistory(SESSION_ID, {});

    expect(result.events).toHaveLength(10);
    expect(result.hasMore).toBe(false);
  });

  it('filters out text-delta and thinking-delta events', async () => {
    const mixedEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'agent:text', text: 'complete' },
      { ...baseEvent, id: 2, type: 'agent:text-delta', text: 'delta' },
      { ...baseEvent, id: 3, type: 'agent:thinking-delta', text: 'tdelta' },
      { ...baseEvent, id: 4, type: 'agent:result', costUsd: 0.01, turns: 1, durationMs: 100 },
    ];
    mockReadFileSync.mockReturnValue(buildLogContent(mixedEvents));

    const result = await getSessionHistory(SESSION_ID, {});

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.type)).toEqual(['agent:text', 'agent:result']);
  });
});
