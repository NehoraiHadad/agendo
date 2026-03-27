import { describe, it, expect } from 'vitest';
import { serializeEvent, readPaginatedEventsFromLog } from '../events';
import type { AgendoEvent } from '../events';

const baseEvent = {
  id: 1,
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  ts: 1700000000000,
};

/** Helper to build a log string from events (with [system] prefix like the real log writer). */
function buildLog(events: AgendoEvent[]): string {
  return events.map((e) => `[system] ${serializeEvent(e)}`).join('');
}

describe('readPaginatedEventsFromLog', () => {
  const events: AgendoEvent[] = Array.from({ length: 20 }, (_, i) => ({
    ...baseEvent,
    id: i + 1,
    type: 'agent:text' as const,
    text: `message-${i + 1}`,
  }));

  const logContent = buildLog(events);

  it('returns all events when no limit is specified', () => {
    const result = readPaginatedEventsFromLog(logContent, {});
    expect(result.events).toHaveLength(20);
    expect(result.hasMore).toBe(false);
    expect(result.oldestSeq).toBe(1);
    expect(result.newestSeq).toBe(20);
  });

  it('returns the last N events when limit is specified', () => {
    const result = readPaginatedEventsFromLog(logContent, { limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.events[0].id).toBe(16);
    expect(result.events[4].id).toBe(20);
    expect(result.hasMore).toBe(true);
    expect(result.oldestSeq).toBe(16);
    expect(result.newestSeq).toBe(20);
  });

  it('returns events before a given cursor', () => {
    const result = readPaginatedEventsFromLog(logContent, { beforeSeq: 16, limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.events[0].id).toBe(11);
    expect(result.events[4].id).toBe(15);
    expect(result.hasMore).toBe(true);
    expect(result.oldestSeq).toBe(11);
    expect(result.newestSeq).toBe(15);
  });

  it('returns events after a given cursor', () => {
    const result = readPaginatedEventsFromLog(logContent, { afterSeq: 15, limit: 3 });
    expect(result.events).toHaveLength(3);
    expect(result.events[0].id).toBe(16);
    expect(result.events[2].id).toBe(18);
    expect(result.hasMore).toBe(true);
    expect(result.oldestSeq).toBe(16);
    expect(result.newestSeq).toBe(18);
  });

  it('returns hasMore=false when no more events exist before cursor', () => {
    const result = readPaginatedEventsFromLog(logContent, { beforeSeq: 4, limit: 10 });
    expect(result.events).toHaveLength(3); // events 1, 2, 3
    expect(result.hasMore).toBe(false);
  });

  it('handles empty log content', () => {
    const result = readPaginatedEventsFromLog('', { limit: 10 });
    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.oldestSeq).toBeNull();
    expect(result.newestSeq).toBeNull();
  });

  it('filters out text-delta and thinking-delta events', () => {
    const mixedEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'agent:text', text: 'complete text' },
      { ...baseEvent, id: 2, type: 'agent:text-delta', text: 'delta' },
      { ...baseEvent, id: 3, type: 'agent:thinking-delta', text: 'thinking delta' },
      { ...baseEvent, id: 4, type: 'agent:thinking', text: 'complete thinking' },
      {
        ...baseEvent,
        id: 5,
        type: 'agent:tool-start',
        toolUseId: 'tu_1',
        toolName: 'read',
        input: {},
      },
    ];
    const mixedLog = buildLog(mixedEvents);
    const result = readPaginatedEventsFromLog(mixedLog, {});
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.type)).toEqual([
      'agent:text',
      'agent:thinking',
      'agent:tool-start',
    ]);
  });

  it('returns correct hasMore with beforeSeq at the very start', () => {
    const result = readPaginatedEventsFromLog(logContent, { beforeSeq: 2, limit: 10 });
    expect(result.events).toHaveLength(1); // only event 1
    expect(result.hasMore).toBe(false);
  });

  it('handles log with [system] prefix lines correctly', () => {
    // The log writer wraps event lines as: [system] [{id}|{type}] {json}
    const prefixedLog = events
      .slice(0, 3)
      .map((e) => `[system] ${serializeEvent(e)}`)
      .join('');
    const result = readPaginatedEventsFromLog(prefixedLog, {});
    expect(result.events).toHaveLength(3);
  });

  it('returns totalCount of all events (unfiltered by cursor)', () => {
    const result = readPaginatedEventsFromLog(logContent, { beforeSeq: 10, limit: 3 });
    expect(result.totalCount).toBe(20);
    expect(result.events).toHaveLength(3);
  });

  it('handles beforeSeq beyond the last event', () => {
    const result = readPaginatedEventsFromLog(logContent, { beforeSeq: 100, limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.events[4].id).toBe(20);
  });

  it('handles afterSeq beyond the last event', () => {
    const result = readPaginatedEventsFromLog(logContent, { afterSeq: 100 });
    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('handles ID resets across session restarts', () => {
    const run1: AgendoEvent[] = [
      { ...baseEvent, id: 98, type: 'agent:text', text: 'run1-a' },
      { ...baseEvent, id: 99, type: 'agent:text', text: 'run1-b' },
      { ...baseEvent, id: 100, type: 'agent:result', costUsd: 0.01, turns: 1, durationMs: 100 },
    ];
    const run2: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'agent:text', text: 'run2-a' },
      { ...baseEvent, id: 2, type: 'agent:text', text: 'run2-b' },
    ];
    const restartLog = buildLog([...run1, ...run2]);

    // Should return all events from both runs
    const result = readPaginatedEventsFromLog(restartLog, {});
    expect(result.events).toHaveLength(5);
    expect(result.totalCount).toBe(5);
  });
});
