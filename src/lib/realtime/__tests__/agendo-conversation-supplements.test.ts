import { describe, it, expect } from 'vitest';
import {
  serializeEvent,
  readAgendoConversationSupplements,
  collectUserMessageTexts,
  AGENDO_CONVERSATION_EVENT_TYPES,
} from '../event-utils';
import type { AgendoEvent, AgendoEventPayload } from '../event-types';

const baseEvent = {
  id: 1,
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  ts: 1700000000000,
};

// ---------------------------------------------------------------------------
// Helper: build a log file from events
// ---------------------------------------------------------------------------

function buildLogContent(events: AgendoEvent[]): string {
  return events.map(serializeEvent).join('');
}

// ---------------------------------------------------------------------------
// AGENDO_CONVERSATION_EVENT_TYPES
// ---------------------------------------------------------------------------

describe('AGENDO_CONVERSATION_EVENT_TYPES', () => {
  it('contains user:message and user:message-cancelled', () => {
    expect(AGENDO_CONVERSATION_EVENT_TYPES.has('user:message')).toBe(true);
    expect(AGENDO_CONVERSATION_EVENT_TYPES.has('user:message-cancelled')).toBe(true);
  });

  it('does not contain CLI-native event types', () => {
    expect(AGENDO_CONVERSATION_EVENT_TYPES.has('agent:text' as 'user:message')).toBe(false);
    expect(AGENDO_CONVERSATION_EVENT_TYPES.has('agent:result' as 'user:message')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectUserMessageTexts
// ---------------------------------------------------------------------------

describe('collectUserMessageTexts', () => {
  it('collects texts from user:message payloads', () => {
    const payloads: AgendoEventPayload[] = [
      { type: 'agent:text', text: 'hello' },
      { type: 'user:message', text: 'first message' },
      { type: 'agent:result', costUsd: null, turns: 1, durationMs: null },
      { type: 'user:message', text: 'second message' },
    ];

    const texts = collectUserMessageTexts(payloads);
    expect(texts).toEqual(new Set(['first message', 'second message']));
  });

  it('returns empty set when no user:message events', () => {
    const payloads: AgendoEventPayload[] = [
      { type: 'agent:text', text: 'hello' },
      { type: 'agent:result', costUsd: null, turns: 1, durationMs: null },
    ];

    const texts = collectUserMessageTexts(payloads);
    expect(texts.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readAgendoConversationSupplements
// ---------------------------------------------------------------------------

describe('readAgendoConversationSupplements', () => {
  it('extracts user:message events from log', () => {
    const logEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'agent:text', text: 'thinking...' },
      { ...baseEvent, id: 2, ts: 1700000001000, type: 'user:message', text: 'hello' },
      { ...baseEvent, id: 3, type: 'agent:result', costUsd: null, turns: 1, durationMs: null },
    ];

    const supplements = readAgendoConversationSupplements(buildLogContent(logEvents));
    expect(supplements).toHaveLength(1);
    expect(supplements[0].type).toBe('user:message');
    expect((supplements[0] as AgendoEvent & { type: 'user:message' }).text).toBe('hello');
  });

  it('extracts user:message-cancelled events from log', () => {
    const logEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'user:message', text: 'first', clientId: 'c1' },
      { ...baseEvent, id: 2, type: 'user:message-cancelled', clientId: 'c1' },
      { ...baseEvent, id: 3, type: 'agent:text', text: 'response' },
    ];

    const supplements = readAgendoConversationSupplements(buildLogContent(logEvents));
    expect(supplements).toHaveLength(2);
    expect(supplements[0].type).toBe('user:message');
    expect(supplements[1].type).toBe('user:message-cancelled');
  });

  it('filters out non-conversation events', () => {
    const logEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'agent:text', text: 'thinking...' },
      { ...baseEvent, id: 2, type: 'system:info', message: 'Process started' },
      {
        ...baseEvent,
        id: 3,
        type: 'agent:tool-start',
        toolUseId: 'tu1',
        toolName: 'read',
        input: {},
      },
      { ...baseEvent, id: 4, type: 'agent:result', costUsd: null, turns: 1, durationMs: null },
    ];

    const supplements = readAgendoConversationSupplements(buildLogContent(logEvents));
    expect(supplements).toHaveLength(0);
  });

  it('deduplicates user:message that already exists in CLI history', () => {
    const logEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'user:message', text: 'normal message' },
      { ...baseEvent, id: 2, type: 'agent:text', text: 'response' },
      { ...baseEvent, id: 3, type: 'user:message', text: 'mid-turn message' },
    ];

    // CLI history already has "normal message" but NOT "mid-turn message"
    const cliUserTexts = new Set(['normal message']);
    const supplements = readAgendoConversationSupplements(buildLogContent(logEvents), cliUserTexts);

    expect(supplements).toHaveLength(1);
    expect((supplements[0] as AgendoEvent & { type: 'user:message' }).text).toBe(
      'mid-turn message',
    );
  });

  it('handles duplicate user texts correctly (dedup only once per occurrence)', () => {
    // User sent "hello" twice — both should appear, but only one is in CLI history
    const logEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'user:message', text: 'hello' },
      { ...baseEvent, id: 2, type: 'agent:text', text: 'first response' },
      { ...baseEvent, id: 3, type: 'user:message', text: 'hello' },
      { ...baseEvent, id: 4, type: 'agent:text', text: 'second response' },
    ];

    // CLI history has one "hello" — the first one became a proper user turn
    const cliUserTexts = new Set(['hello']);
    const supplements = readAgendoConversationSupplements(buildLogContent(logEvents), cliUserTexts);

    // Only the second "hello" should remain (the one CLI history missed)
    expect(supplements).toHaveLength(1);
    expect((supplements[0] as AgendoEvent & { type: 'user:message' }).text).toBe('hello');
    expect(supplements[0].id).toBe(3); // second occurrence
  });

  it('returns empty array for empty log', () => {
    const supplements = readAgendoConversationSupplements('');
    expect(supplements).toHaveLength(0);
  });

  it('returns empty array when all user events are in CLI history', () => {
    const logEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'user:message', text: 'msg1' },
      { ...baseEvent, id: 2, type: 'user:message', text: 'msg2' },
    ];

    const cliUserTexts = new Set(['msg1', 'msg2']);
    const supplements = readAgendoConversationSupplements(buildLogContent(logEvents), cliUserTexts);

    expect(supplements).toHaveLength(0);
  });

  it('preserves original event IDs and timestamps', () => {
    const logEvents: AgendoEvent[] = [
      {
        ...baseEvent,
        id: 345,
        ts: 1700000042000,
        type: 'user:message',
        text: 'mid-turn msg',
      },
    ];

    const supplements = readAgendoConversationSupplements(buildLogContent(logEvents));
    expect(supplements).toHaveLength(1);
    expect(supplements[0].id).toBe(345);
    expect(supplements[0].ts).toBe(1700000042000);
  });

  it('works without cliUserTexts (no dedup)', () => {
    const logEvents: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'user:message', text: 'msg1' },
      { ...baseEvent, id: 2, type: 'user:message', text: 'msg2' },
    ];

    // No cliUserTexts → no dedup, all user events returned
    const supplements = readAgendoConversationSupplements(buildLogContent(logEvents));
    expect(supplements).toHaveLength(2);
  });
});
