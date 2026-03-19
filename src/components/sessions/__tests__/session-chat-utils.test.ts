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

  it('attaches turnMeta to last assistant bubble for non-error agent:result', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:text', text: 'Hello' },
      { ...base, id: 2, type: 'agent:result', turns: 3, durationMs: 1500, costUsd: 0.01 },
    ];
    const items = buildDisplayItems(events, emptyMap);
    // Should NOT create a turn-complete item — metadata is on the assistant bubble.
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('assistant');
    if (items[0].kind === 'assistant') {
      expect(items[0].turnMeta).toBeDefined();
      expect(items[0].turnMeta!.costUsd).toBe(0.01);
      expect(items[0].turnMeta!.turns).toBe(3);
      expect(items[0].turnMeta!.durationMs).toBe(1500);
    }
  });

  it('creates turn-complete pill for error agent:result', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:text', text: 'Oops' },
      {
        ...base,
        id: 2,
        type: 'agent:result',
        isError: true,
        subtype: 'error_max_turns',
        turns: 5,
        durationMs: 3000,
        costUsd: 0.05,
      },
    ];
    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(2);
    expect(items[1].kind).toBe('turn-complete');
    if (items[1].kind === 'turn-complete') {
      expect(items[1].text).toContain('Max turns reached');
      expect(items[1].isError).toBe(true);
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

  describe('protocol XML stripping', () => {
    it('strips Claude Code slash command XML from agent:text events', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'agent:text',
          text: '<local-command-stdout>Bye!</local-command-stdout>//<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      // All protocol XML → empty text → event should be skipped entirely
      expect(items).toHaveLength(0);
    });

    it('preserves normal text that has no protocol XML', () => {
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'agent:text', text: 'Hello <b>world</b>' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(1);
      if (items[0].kind === 'assistant') {
        expect(items[0].parts[0]).toEqual({ kind: 'text', text: 'Hello <b>world</b>' });
      }
    });

    it('strips protocol XML but keeps surrounding real text', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'agent:text',
          text: 'Before <command-name>/help</command-name> After',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(1);
      if (items[0].kind === 'assistant') {
        expect(items[0].parts[0]).toEqual({ kind: 'text', text: 'Before  After' });
      }
    });

    it('strips local-command-stdout tags and their content', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'agent:text',
          text: '<local-command-stdout>some output</local-command-stdout>',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      // Complete <tag>content</tag> pair is stripped → empty → skipped
      expect(items).toHaveLength(0);
    });

    it('surfaces local-command-stderr content as error pill', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'agent:text',
          text: '<local-command-stderr>Unknown command: /foobar</local-command-stderr>',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('error');
      if (items[0].kind === 'error') {
        expect(items[0].text).toBe('Unknown command: /foobar');
      }
    });

    it('surfaces stderr as error while still showing remaining clean text', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'agent:text',
          text: 'Real output <local-command-stderr>warning: something</local-command-stderr> more text',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      // Should have error pill + assistant bubble with clean text
      const errorItems = items.filter((i) => i.kind === 'error');
      const assistantItems = items.filter((i) => i.kind === 'assistant');
      expect(errorItems).toHaveLength(1);
      expect(assistantItems).toHaveLength(1);
      if (errorItems[0].kind === 'error') {
        expect(errorItems[0].text).toBe('warning: something');
      }
      if (assistantItems[0].kind === 'assistant') {
        expect(assistantItems[0].parts[0]).toEqual({
          kind: 'text',
          text: 'Real output  more text',
        });
      }
    });

    it('strips teammate-message tags with attributes', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'agent:text',
          text: '<teammate-message teammate_id="auditor-events" color="green">\n{"type":"idle_notification","from":"auditor-events"}\n</teammate-message>',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(0);
    });

    it('strips multiple consecutive teammate-message tags', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'agent:text',
          text: '<teammate-message teammate_id="a" color="green">{"type":"idle_notification"}</teammate-message>\n\n<teammate-message teammate_id="a" color="green">{"type":"shutdown_response"}</teammate-message>',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(0);
    });

    it('preserves real text mixed with teammate-message tags', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'agent:text',
          text: 'Starting work now. <teammate-message teammate_id="x" color="blue">{"type":"idle_notification"}</teammate-message>',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('assistant');
      if (items[0].kind === 'assistant') {
        expect(items[0].parts[0]).toEqual({ kind: 'text', text: 'Starting work now.' });
      }
    });
  });

  describe('user:message protocol XML filtering', () => {
    it('strips teammate-message XML from user:message (CLI history reconstruction)', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'user:message',
          text: '<teammate-message teammate_id="implementer-1" color="yellow">\n{"type":"idle_notification","from":"implementer-1"}\n</teammate-message>',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      // Pure protocol XML → skipped entirely
      expect(items).toHaveLength(0);
    });

    it('preserves real user text mixed with teammate-message XML', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'user:message',
          text: 'Please proceed. <teammate-message teammate_id="x" color="blue">{"type":"idle_notification"}</teammate-message>',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('user');
      if (items[0].kind === 'user') {
        expect(items[0].text).toBe('Please proceed.');
      }
    });

    it('still skips [Message from teammate] injections', () => {
      const events: AgendoEvent[] = [
        {
          ...base,
          id: 1,
          type: 'user:message',
          text: '[Message from teammate researcher-1]:\nHere is my report.',
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      expect(items).toHaveLength(0);
    });
  });

  describe('team:message events', () => {
    it('excludes team:message from chat display items (Team Panel only)', () => {
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
      // team:message events are handled by the Team Panel, not the chat
      expect(items).toHaveLength(0);
    });

    it('does not break assistant bubble continuity', () => {
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
        { ...base, id: 3, type: 'agent:text', text: ' and after' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      // team:message is skipped, so the two agent:text events merge into one bubble
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('assistant');
      if (items[0].kind === 'assistant') {
        expect(items[0].parts[0]).toEqual({ kind: 'text', text: 'Before message and after' });
      }
    });
  });
});
