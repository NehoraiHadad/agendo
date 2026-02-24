import { describe, it, expect } from 'vitest';
import { buildDisplayItems, buildToolResultMap, extractToolContent } from '../session-chat-utils';
import type { AgendoEvent } from '@/lib/realtime/events';

const base = { sessionId: 'test-session', ts: 0 };

describe('extractToolContent', () => {
  it('returns string content as-is', () => {
    expect(extractToolContent('hello world')).toBe('hello world');
  });

  it('extracts text from array of content blocks', () => {
    const blocks = [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ];
    expect(extractToolContent(blocks)).toBe('line one\nline two');
  });

  it('skips non-text blocks in array', () => {
    const blocks = [
      { type: 'image', data: 'base64' },
      { type: 'text', text: 'result' },
    ];
    expect(extractToolContent(blocks)).toBe('result');
  });

  it('falls back to JSON.stringify for unknown types', () => {
    expect(extractToolContent({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  it('handles null/undefined gracefully', () => {
    expect(extractToolContent(null)).toBe('""');
    expect(extractToolContent(undefined)).toBe('""');
  });
});

describe('buildToolResultMap', () => {
  it('returns empty map for empty events', () => {
    const map = buildToolResultMap([]);
    expect(map.size).toBe(0);
  });

  it('maps tool-end events by toolUseId', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:tool-end', toolUseId: 'tool-1', content: 'result text' },
    ];
    const map = buildToolResultMap(events);
    expect(map.size).toBe(1);
    expect(map.get('tool-1')).toEqual({ content: 'result text', isError: false });
  });

  it('ignores non-tool-end events', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:text', text: 'Hello' },
      { ...base, id: 2, type: 'agent:tool-end', toolUseId: 'tool-2', content: 'file contents' },
    ];
    const map = buildToolResultMap(events);
    expect(map.size).toBe(1);
    expect(map.has('tool-2')).toBe(true);
  });

  it('handles multiple tool results', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:tool-end', toolUseId: 'a', content: 'r1' },
      { ...base, id: 2, type: 'agent:tool-end', toolUseId: 'b', content: 'r2' },
    ];
    const map = buildToolResultMap(events);
    expect(map.size).toBe(2);
    expect(map.get('a')?.content).toBe('r1');
    expect(map.get('b')?.content).toBe('r2');
  });
});

describe('buildDisplayItems', () => {
  const emptyMap = new Map();

  it('returns empty array for empty events', () => {
    expect(buildDisplayItems([], emptyMap)).toEqual([]);
  });

  it('creates assistant item for agent:text event', () => {
    const events: AgendoEvent[] = [{ ...base, id: 1, type: 'agent:text', text: 'Hello!' }];
    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('assistant');
    if (items[0].kind === 'assistant') {
      expect(items[0].parts).toHaveLength(1);
      expect(items[0].parts[0]).toEqual({ kind: 'text', text: 'Hello!' });
    }
  });

  it('concatenates consecutive agent:text events into one assistant bubble', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:text', text: 'Hello ' },
      { ...base, id: 2, type: 'agent:text', text: 'world' },
    ];
    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(1);
    if (items[0].kind === 'assistant') {
      expect(items[0].parts[0]).toEqual({ kind: 'text', text: 'Hello world' });
    }
  });

  it('creates user item for user:message event', () => {
    const events: AgendoEvent[] = [{ ...base, id: 1, type: 'user:message', text: 'user input' }];
    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('user');
    if (items[0].kind === 'user') {
      expect(items[0].text).toBe('user input');
    }
  });

  it('creates info item for session:init (first one only)', () => {
    const events: AgendoEvent[] = [
      {
        ...base,
        id: 1,
        type: 'session:init',
        sessionRef: 'ref1',
        slashCommands: [],
        mcpServers: [],
      },
      {
        ...base,
        id: 2,
        type: 'session:init',
        sessionRef: 'ref2',
        slashCommands: [],
        mcpServers: [],
      },
    ];
    const items = buildDisplayItems(events, emptyMap);
    const infoItems = items.filter((i) => i.kind === 'info');
    expect(infoItems).toHaveLength(1);
    if (infoItems[0].kind === 'info') {
      expect(infoItems[0].text).toBe('Session started');
    }
  });

  it('creates error item for system:error event', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'system:error', message: 'Something failed' },
    ];
    const items = buildDisplayItems(events, emptyMap);
    expect(items[0].kind).toBe('error');
    if (items[0].kind === 'error') {
      expect(items[0].text).toBe('Something failed');
    }
  });

  it('hydrates tool-start with result from toolResultMap', () => {
    const toolResultMap = new Map([['tool-1', { content: 'result', isError: false }]]);
    const events: AgendoEvent[] = [
      {
        ...base,
        id: 1,
        type: 'agent:tool-start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
    ];
    const items = buildDisplayItems(events, toolResultMap);
    expect(items).toHaveLength(1);
    if (items[0].kind === 'assistant') {
      const toolPart = items[0].parts[0];
      if (toolPart.kind === 'tool') {
        expect(toolPart.tool.result).toEqual({ content: 'result', isError: false });
      }
    }
  });

  it('creates turn-complete item for agent:result event', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:result', turns: 3, durationMs: 1500, costUsd: 0.01 },
    ];
    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('turn-complete');
    if (items[0].kind === 'turn-complete') {
      expect(items[0].text).toContain('Turn complete');
      expect(items[0].costUsd).toBe(0.01);
    }
  });

  it('groups tool call within the preceding assistant bubble', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:text', text: 'Running a command' },
      {
        ...base,
        id: 2,
        type: 'agent:tool-start',
        toolUseId: 'tool-x',
        toolName: 'Bash',
        input: { command: 'pwd' },
      },
    ];
    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(1);
    if (items[0].kind === 'assistant') {
      expect(items[0].parts).toHaveLength(2);
      expect(items[0].parts[0].kind).toBe('text');
      expect(items[0].parts[1].kind).toBe('tool');
    }
  });

  describe('team:message events', () => {
    it('creates a team-message item for team:message event', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 10,
          type: 'team:message',
          fromAgent: 'mobile-analyst',
          text: '# Analysis\nResults here.',
          summary: 'Analysis complete',
          color: 'blue',
          sourceTimestamp: '2026-02-23T21:09:41.557Z',
          isStructured: false,
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('team-message');
      if (items[0].kind === 'team-message') {
        expect(items[0].fromAgent).toBe('mobile-analyst');
        expect(items[0].text).toBe('# Analysis\nResults here.');
        expect(items[0].summary).toBe('Analysis complete');
        expect(items[0].color).toBe('blue');
        expect(items[0].isStructured).toBe(false);
        expect(items[0].sourceTimestamp).toBe('2026-02-23T21:09:41.557Z');
      }
    });

    it('preserves structuredPayload for JSON-encoded messages', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 11,
          type: 'team:message',
          fromAgent: 'worker-agent',
          text: '{"type":"idle_notification"}',
          isStructured: true,
          structuredPayload: { type: 'idle_notification' },
          sourceTimestamp: '2026-02-23T22:00:00.000Z',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(1);
      if (items[0].kind === 'team-message') {
        expect(items[0].isStructured).toBe(true);
        expect(items[0].structuredPayload).toEqual({ type: 'idle_notification' });
      }
    });

    it('interleaves team:message chronologically with other events', () => {
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'user:message', text: 'Start work' },
        { ...base, id: 2, type: 'agent:text', text: 'Working...' },
        {
          ...base,
          id: 3,
          type: 'team:message',
          fromAgent: 'sub-agent',
          text: 'Subtask done',
          isStructured: false,
          sourceTimestamp: '2026-02-23T21:00:00.000Z',
        },
        { ...base, id: 4, type: 'agent:text', text: 'Got the report.' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      // Expected: user, assistant(Working...), team-message, assistant(Got the report.)
      expect(items).toHaveLength(4);
      expect(items[0].kind).toBe('user');
      expect(items[1].kind).toBe('assistant');
      expect(items[2].kind).toBe('team-message');
      expect(items[3].kind).toBe('assistant');
    });

    it('breaks the assistant bubble before a team-message event', () => {
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'agent:text', text: 'Before message' },
        {
          ...base,
          id: 2,
          type: 'team:message',
          fromAgent: 'agent-x',
          text: 'Report',
          isStructured: false,
          sourceTimestamp: '2026-02-23T21:00:00.000Z',
        },
        { ...base, id: 3, type: 'agent:text', text: 'After message' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      // agent:text before and after team:message must be separate assistant bubbles
      expect(items).toHaveLength(3);
      expect(items[0].kind).toBe('assistant');
      expect(items[1].kind).toBe('team-message');
      expect(items[2].kind).toBe('assistant');
    });

    it('uses event id as the item id', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 42,
          type: 'team:message',
          fromAgent: 'agent',
          text: 'msg',
          isStructured: false,
          sourceTimestamp: '2026-02-23T21:00:00.000Z',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items[0].id).toBe(42);
    });
  });
});
