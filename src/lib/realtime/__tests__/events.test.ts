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
    {
      ...baseEvent,
      id: 3,
      type: 'agent:tool-start',
      toolUseId: 'tu_1',
      toolName: 'read_file',
      input: { path: '/foo' },
    },
    { ...baseEvent, id: 4, type: 'agent:tool-end', toolUseId: 'tu_1', content: 'file contents' },
    { ...baseEvent, id: 5, type: 'agent:result', costUsd: 0.001, turns: 3, durationMs: 1500 },
    {
      ...baseEvent,
      id: 6,
      type: 'session:init',
      sessionRef: 'sess_abc123',
      slashCommands: [],
      mcpServers: [],
    },
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

  it('handles event ID reset after session restart', () => {
    // Simulates: run 1 goes to ID 500, session restarts, run 2 starts at ID 100.
    // If afterSeq=500 (client had seen up to 500), events from run 2 with
    // IDs 100-500 would be silently skipped without the reset detection.
    const run1Events: AgendoEvent[] = [
      { ...baseEvent, id: 498, type: 'agent:text', text: 'run1-a' },
      { ...baseEvent, id: 499, type: 'agent:text', text: 'run1-b' },
      { ...baseEvent, id: 500, type: 'agent:result', costUsd: 0.01, turns: 1, durationMs: 100 },
    ];
    const run2Events: AgendoEvent[] = [
      { ...baseEvent, id: 100, type: 'user:message', text: 'user msg after restart' },
      { ...baseEvent, id: 105, type: 'agent:text', text: 'run2-response' },
      { ...baseEvent, id: 110, type: 'agent:result', costUsd: 0.02, turns: 1, durationMs: 200 },
    ];

    const logContent = [...run1Events, ...run2Events].map(serializeEvent).join('');

    // Client reconnects with afterSeq=500 (saw all of run 1)
    const result = readEventsFromLog(logContent, 500);

    // Should include ALL events from run 2 (after the ID reset)
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe(100);
    expect((result[0] as { text: string }).text).toBe('user msg after restart');
    expect(result[1].id).toBe(105);
    expect(result[2].id).toBe(110);
  });

  it('includes events from both runs when afterSeq is mid-run1', () => {
    const run1Events: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'agent:text', text: 'first' },
      { ...baseEvent, id: 2, type: 'agent:text', text: 'second' },
      { ...baseEvent, id: 500, type: 'agent:result', costUsd: 0.01, turns: 1, durationMs: 100 },
    ];
    const run2Events: AgendoEvent[] = [
      { ...baseEvent, id: 50, type: 'agent:text', text: 'after-restart' },
    ];

    const logContent = [...run1Events, ...run2Events].map(serializeEvent).join('');

    // Client saw up to event 1 — should get events 2, 500 from run 1, plus all of run 2
    const result = readEventsFromLog(logContent, 1);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe(2);
    expect(result[1].id).toBe(500);
    expect(result[2].id).toBe(50);
  });

  it('detects ID reset after short orchestrator lifecycle (<100 events)', () => {
    // Simulates a brainstorm room with a short lifecycle: run 1 has only 20
    // events, then the orchestrator restarts at ID 1. The old fixed threshold
    // of 100 would NOT detect this reset (20 - 100 = -80, and 1 < -80 is false).
    const run1Events: AgendoEvent[] = [
      { ...baseEvent, id: 18, type: 'agent:text', text: 'run1-a' },
      { ...baseEvent, id: 19, type: 'agent:text', text: 'run1-b' },
      { ...baseEvent, id: 20, type: 'agent:result', costUsd: 0.01, turns: 1, durationMs: 100 },
    ];
    const run2Events: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'agent:text', text: 'run2-start' },
      { ...baseEvent, id: 2, type: 'agent:text', text: 'run2-response' },
    ];

    const logContent = [...run1Events, ...run2Events].map(serializeEvent).join('');

    // Client saw all of run 1 (afterSeq=20)
    const result = readEventsFromLog(logContent, 20);

    // Should include ALL events from run 2 (after the ID reset)
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect((result[0] as { text: string }).text).toBe('run2-start');
    expect(result[1].id).toBe(2);
  });

  it('does not false-positive on small ID gaps within the same run', () => {
    // IDs with small gaps (e.g., 10 → 8 due to out-of-order write) should
    // NOT be treated as a reset.
    const events: AgendoEvent[] = [
      { ...baseEvent, id: 8, type: 'agent:text', text: 'a' },
      { ...baseEvent, id: 10, type: 'agent:text', text: 'b' },
      { ...baseEvent, id: 9, type: 'agent:text', text: 'c' },
      { ...baseEvent, id: 11, type: 'agent:text', text: 'd' },
    ];

    const logContent = events.map(serializeEvent).join('');

    // afterSeq=7 — should get all 4 events, no false reset
    const result = readEventsFromLog(logContent, 7);
    expect(result).toHaveLength(4);
  });
});
