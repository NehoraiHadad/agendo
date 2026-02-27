import { describe, it, expect } from 'vitest';
import { convertClaudeLines } from '../convert-claude';

const SESSION_ID = 'test-session-id';

function makeLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function makeUserLine(
  content: string | Array<Record<string, unknown>>,
  extra?: Record<string, unknown>,
): string {
  return makeLine({
    type: 'user',
    sessionId: 'cli-session-1',
    timestamp: '2026-02-26T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  });
}

function makeAssistantLine(
  content: Array<Record<string, unknown>>,
  extra?: { stop_reason?: string; model?: string; usage?: Record<string, unknown> },
): string {
  return makeLine({
    type: 'assistant',
    sessionId: 'cli-session-1',
    timestamp: '2026-02-26T10:00:01.000Z',
    message: {
      role: 'assistant',
      model: extra?.model ?? 'claude-opus-4-6',
      content,
      stop_reason: extra?.stop_reason ?? null,
      usage: extra?.usage ?? {},
    },
  });
}

describe('convertClaudeLines', () => {
  it('converts user message with string content to user:message', () => {
    const raw = makeUserLine('Hello world');
    const { events } = convertClaudeLines(raw, SESSION_ID);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user:message');
    if (events[0].type === 'user:message') {
      expect(events[0].text).toBe('Hello world');
    }
  });

  it('converts user message with array content to user:message', () => {
    const raw = makeUserLine([{ type: 'text', text: 'Array hello' }]);
    const { events } = convertClaudeLines(raw, SESSION_ID);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user:message');
    if (events[0].type === 'user:message') {
      expect(events[0].text).toBe('Array hello');
    }
  });

  it('converts assistant thinking + text into two separate events', () => {
    const raw = makeAssistantLine([
      { type: 'thinking', thinking: 'Let me think...' },
      { type: 'text', text: 'Here is my answer.' },
    ]);
    const { events } = convertClaudeLines(raw, SESSION_ID);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent:thinking');
    expect(events[1].type).toBe('agent:text');
    if (events[0].type === 'agent:thinking') {
      expect(events[0].text).toBe('Let me think...');
    }
    if (events[1].type === 'agent:text') {
      expect(events[1].text).toBe('Here is my answer.');
    }
  });

  it('converts assistant tool_use to agent:tool-start', () => {
    const raw = makeAssistantLine([
      { type: 'tool_use', id: 'toolu_123', name: 'Read', input: { file_path: '/foo' } },
    ]);
    const { events } = convertClaudeLines(raw, SESSION_ID);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent:tool-start');
    if (events[0].type === 'agent:tool-start') {
      expect(events[0].toolUseId).toBe('toolu_123');
      expect(events[0].toolName).toBe('Read');
      expect(events[0].input).toEqual({ file_path: '/foo' });
    }
  });

  it('converts tool_result to agent:tool-end', () => {
    const raw = makeUserLine([
      { type: 'tool_result', tool_use_id: 'toolu_123', content: 'file contents here' },
    ]);
    const { events } = convertClaudeLines(raw, SESSION_ID);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent:tool-end');
    if (events[0].type === 'agent:tool-end') {
      expect(events[0].toolUseId).toBe('toolu_123');
      expect(events[0].content).toBe('file contents here');
    }
  });

  it('converts mixed content blocks into multiple events in order', () => {
    const lines = [
      makeUserLine('Start task'),
      makeAssistantLine([
        { type: 'thinking', thinking: 'Planning...' },
        { type: 'text', text: 'I will read the file.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } },
      ]),
      makeUserLine([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'data' }]),
    ].join('\n');

    const { events } = convertClaudeLines(lines, SESSION_ID);

    expect(events.map((e) => e.type)).toEqual([
      'user:message',
      'agent:thinking',
      'agent:text',
      'agent:tool-start',
      'agent:tool-end',
    ]);
  });

  it('generates agent:result on stop_reason=end_turn', () => {
    const raw = makeAssistantLine([{ type: 'text', text: 'Done.' }], { stop_reason: 'end_turn' });
    const { events, metadata } = convertClaudeLines(raw, SESSION_ID);

    const results = events.filter((e) => e.type === 'agent:result');
    expect(results).toHaveLength(1);
    if (results[0].type === 'agent:result') {
      expect(results[0].turns).toBe(1);
    }
    expect(metadata.totalTurns).toBe(1);
  });

  it('skips malformed lines and maintains monotonic IDs', () => {
    const lines = [
      'not valid json',
      makeUserLine('First message'),
      '{ broken json',
      makeUserLine('Second message'),
    ].join('\n');

    const { events } = convertClaudeLines(lines, SESSION_ID);

    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(1);
    expect(events[1].id).toBe(2);
  });

  it('skips file-history-snapshot, progress, and queue-operation types', () => {
    const lines = [
      makeLine({ type: 'file-history-snapshot', snapshot: {} }),
      makeLine({ type: 'progress', data: {} }),
      makeLine({ type: 'queue-operation', operation: 'enqueue' }),
      makeUserLine('Real message'),
    ].join('\n');

    const { events } = convertClaudeLines(lines, SESSION_ID);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user:message');
  });

  it('skips sidechain messages', () => {
    const lines = [
      makeUserLine('Main message'),
      makeUserLine('Sidechain message', { isSidechain: true }),
    ].join('\n');

    const { events } = convertClaudeLines(lines, SESSION_ID);

    expect(events).toHaveLength(1);
  });

  it('extracts model and sessionRef in metadata', () => {
    const lines = [
      makeUserLine('Hello'),
      makeAssistantLine([{ type: 'text', text: 'Hi' }], { model: 'claude-sonnet-4-6' }),
    ].join('\n');

    const { metadata } = convertClaudeLines(lines, SESSION_ID);

    expect(metadata.model).toBe('claude-sonnet-4-6');
    expect(metadata.sessionRef).toBe('cli-session-1');
    expect(metadata.firstPrompt).toBe('Hello');
  });

  it('handles user message with both text and tool_result blocks', () => {
    const raw = makeUserLine([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result data' },
      { type: 'text', text: 'And here is my follow-up' },
    ]);

    const { events } = convertClaudeLines(raw, SESSION_ID);

    // Text comes first (extractUserText runs before extractToolResults)
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('user:message');
    expect(events[1].type).toBe('agent:tool-end');
  });
});
