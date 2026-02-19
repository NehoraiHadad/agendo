import { describe, it, expect } from 'vitest';
import { serializeEvent, deserializeEvent, readEventsFromLog } from '../events';
import type { AgendoEvent } from '../events';

const baseEvent = {
  id: 1,
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  ts: 1700000000000,
};

describe('serializeEvent / deserializeEvent round-trip', () => {
  const testCases: AgendoEvent[] = [
    { ...baseEvent, type: 'agent:text', text: 'Hello world' },
    { ...baseEvent, id: 2, type: 'agent:thinking', text: 'Thinking...' },
    { ...baseEvent, id: 3, type: 'agent:tool-start', toolUseId: 'tu_1', toolName: 'read_file', input: { path: '/foo' } },
    { ...baseEvent, id: 4, type: 'agent:tool-end', toolUseId: 'tu_1', content: 'file contents' },
    { ...baseEvent, id: 5, type: 'agent:result', costUsd: 0.001, turns: 3, durationMs: 1500 },
    { ...baseEvent, id: 6, type: 'session:init', sessionRef: 'sess_abc123', slashCommands: [], mcpServers: [] },
    { ...baseEvent, id: 7, type: 'session:state', status: 'awaiting_input' },
    { ...baseEvent, id: 8, type: 'user:message', text: 'User message' },
    { ...baseEvent, id: 9, type: 'system:info', message: 'Process started' },
    { ...baseEvent, id: 10, type: 'system:error', message: 'Something went wrong' },
  ];

  for (const event of testCases) {
    it(`round-trips ${event.type}`, () => {
      const serialized = serializeEvent(event);
      expect(serialized).toMatch(/^\[\d+\|[^\]]+\] \{.+\}\n$/);
      const deserialized = deserializeEvent(serialized.trim());
      expect(deserialized).toEqual(event);
    });
  }
});

describe('deserializeEvent', () => {
  it('returns null for non-event lines', () => {
    expect(deserializeEvent('')).toBeNull();
    expect(deserializeEvent('[stdout] some output')).toBeNull();
    expect(deserializeEvent('not a valid line')).toBeNull();
    expect(deserializeEvent('[1|agent:text] invalid-json{')).toBeNull();
  });
});

describe('readEventsFromLog', () => {
  it('filters events by afterSeq', () => {
    const events: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'agent:text', text: 'first' },
      { ...baseEvent, id: 2, type: 'agent:text', text: 'second' },
      { ...baseEvent, id: 3, type: 'agent:text', text: 'third' },
    ];
    const logContent = events.map(serializeEvent).join('');
    const result = readEventsFromLog(logContent, 1);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(2);
    expect(result[1].id).toBe(3);
  });

  it('handles empty log content', () => {
    expect(readEventsFromLog('', 0)).toEqual([]);
  });

  it('skips non-event lines mixed in', () => {
    const event: AgendoEvent = { ...baseEvent, id: 1, type: 'agent:text', text: 'hello' };
    const logContent = `[stdout] some raw output\n${serializeEvent(event)}[system] other line\n`;
    const result = readEventsFromLog(logContent, 0);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });
});
