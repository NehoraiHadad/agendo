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

  it('preserves attachment metadata on user messages', () => {
    const attachments = [
      {
        id: 'att-1',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 42,
        kind: 'file' as const,
      },
    ];
    const events: AgendoEvent[] = [
      {
        ...base,
        id: 1,
        type: 'user:message',
        text: 'see attachment',
        attachments,
      },
    ];
    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('user');
    if (items[0].kind === 'user') {
      expect(items[0].attachments).toEqual(attachments);
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

  it('keeps Codex command output inside the tool card while the tool is running', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'agent:text', text: 'Running command' },
      {
        ...base,
        id: 2,
        type: 'agent:tool-start',
        toolUseId: 'cmd-1',
        toolName: 'Bash',
        input: { command: 'ls -la' },
      },
      {
        ...base,
        id: 3,
        type: 'agent:tool-progress',
        toolUseId: 'cmd-1',
        content: 'file-a\n',
      },
      {
        ...base,
        id: 4,
        type: 'agent:tool-progress',
        toolUseId: 'cmd-1',
        content: 'file-b\n',
      },
    ];

    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('assistant');
    if (items[0].kind === 'assistant') {
      expect(items[0].parts).toHaveLength(2);
      const toolPart = items[0].parts[1];
      expect(toolPart.kind).toBe('tool');
      if (toolPart.kind === 'tool') {
        expect(toolPart.tool.result).toBeUndefined();
        expect(toolPart.tool.liveResult).toEqual({
          content: 'file-a\nfile-b\n',
          isError: false,
        });
      }
    }
  });

  it('replaces live tool output with the final tool result when the tool completes', () => {
    const events: AgendoEvent[] = [
      {
        ...base,
        id: 1,
        type: 'agent:tool-start',
        toolUseId: 'cmd-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
      },
      {
        ...base,
        id: 2,
        type: 'agent:tool-progress',
        toolUseId: 'cmd-1',
        content: '/tmp\n',
      },
      {
        ...base,
        id: 3,
        type: 'agent:tool-end',
        toolUseId: 'cmd-1',
        content: '/home/ubuntu/projects/agendo\n',
      },
    ];

    const items = buildDisplayItems(events, emptyMap);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('assistant');
    if (items[0].kind === 'assistant') {
      const toolPart = items[0].parts[0];
      expect(toolPart.kind).toBe('tool');
      if (toolPart.kind === 'tool') {
        expect(toolPart.tool.liveResult).toBeUndefined();
        expect(toolPart.tool.result).toEqual({
          content: '/home/ubuntu/projects/agendo\n',
          isError: false,
        });
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

  it('dedupes repeated compact-start events until compaction completes', () => {
    const events: AgendoEvent[] = [
      { ...base, id: 1, type: 'system:compact-start', trigger: 'auto' },
      { ...base, id: 2, type: 'system:compact-start', trigger: 'auto' },
      { ...base, id: 3, type: 'system:info', message: 'Context compacted. Resuming response…' },
      { ...base, id: 4, type: 'system:compact-start', trigger: 'auto' },
    ];
    const items = buildDisplayItems(events, emptyMap);
    expect(items.filter((item) => item.kind === 'compact-loading')).toHaveLength(2);
    expect(items.filter((item) => item.kind === 'info')).toHaveLength(1);
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

  describe('mid-turn user message handling (history split vs live merge)', () => {
    it('splits non-delta (history) agent:text bubbles when user:message arrives mid-turn', () => {
      // After refresh, events come from history as agent:text (no deltas).
      // Split is safe — agent:text events have natural content boundaries.
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'agent:text', text: 'Hello ' },
        { ...base, id: 2, type: 'user:message', text: 'wait' },
        { ...base, id: 3, type: 'agent:text', text: 'world!' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      const assistantItems = items.filter((i) => i.kind === 'assistant');
      const userItems = items.filter((i) => i.kind === 'user');
      expect(assistantItems).toHaveLength(2);
      expect(userItems).toHaveLength(1);
      if (assistantItems[0].kind === 'assistant') {
        expect(assistantItems[0].parts[0]).toEqual({ kind: 'text', text: 'Hello ' });
      }
      if (assistantItems[1].kind === 'assistant') {
        expect(assistantItems[1].parts[0]).toEqual({ kind: 'text', text: 'world!' });
      }
      const allKinds = items
        .filter((i) => ['assistant', 'user'].includes(i.kind))
        .map((i) => i.kind);
      expect(allKinds).toEqual(['assistant', 'user', 'assistant']);
    });

    it('does NOT split delta (live streaming) bubbles — avoids cutting words', () => {
      // During live streaming, splitting at delta boundaries cuts words/sentences.
      // Keep the old merge behavior: user message appears after the full response.
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'agent:text-delta', text: 'Hel' },
        { ...base, id: 2, type: 'agent:text-delta', text: 'lo ' },
        { ...base, id: 3, type: 'user:message', text: 'stop' },
        { ...base, id: 4, type: 'agent:text-delta', text: 'world' },
        { ...base, id: 5, type: 'agent:text', text: 'Hello world' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      const assistantItems = items.filter((i) => i.kind === 'assistant');
      // All text stays in one bubble (no split during streaming)
      expect(assistantItems).toHaveLength(1);
      if (assistantItems[0].kind === 'assistant') {
        const part = assistantItems[0].parts[0];
        expect(part.kind).toBe('text');
        if (part.kind === 'text') {
          expect(part.text).toBe('Hello world');
          expect(part.fromDelta).toBe(false);
        }
      }
    });

    it('splits non-delta tool into new bubble when user:message arrives between text and tool', () => {
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'agent:text', text: 'Let me check...' },
        { ...base, id: 2, type: 'user:message', text: 'ok' },
        {
          ...base,
          id: 3,
          type: 'agent:tool-start',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: { command: 'ls' },
        },
      ];
      const items = buildDisplayItems(events, emptyMap);
      const assistantItems = items.filter((i) => i.kind === 'assistant');
      expect(assistantItems).toHaveLength(2);
      if (assistantItems[0].kind === 'assistant') {
        expect(assistantItems[0].parts).toHaveLength(1);
        expect(assistantItems[0].parts[0].kind).toBe('text');
      }
      if (assistantItems[1].kind === 'assistant') {
        expect(assistantItems[1].parts).toHaveLength(1);
        expect(assistantItems[1].parts[0].kind).toBe('tool');
      }
    });

    it('does NOT split thinking delta bubbles during live streaming', () => {
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'agent:thinking-delta', text: 'Let me ' },
        { ...base, id: 2, type: 'user:message', text: 'hurry' },
        { ...base, id: 3, type: 'agent:thinking-delta', text: 'think...' },
        { ...base, id: 4, type: 'agent:thinking', text: 'Let me think...' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      const thinkingItems = items.filter((i) => i.kind === 'thinking');
      // Thinking resets on user:message, so post-split deltas go to a new bubble.
      // But agent:thinking replaces it with the complete text (no split-aware logic).
      expect(thinkingItems).toHaveLength(2);
      if (thinkingItems[0].kind === 'thinking') {
        expect(thinkingItems[0].text).toBe('Let me ');
      }
      if (thinkingItems[1].kind === 'thinking') {
        expect(thinkingItems[1].text).toBe('Let me think...');
      }
    });

    it('starts a NEW assistant bubble after agent:result + user:message', () => {
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'agent:text', text: 'Turn 1 response' },
        { ...base, id: 2, type: 'agent:result', turns: 1, durationMs: 100, costUsd: 0.01 },
        { ...base, id: 3, type: 'user:message', text: 'Next question' },
        { ...base, id: 4, type: 'agent:text', text: 'Turn 2 response' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      const assistantItems = items.filter((i) => i.kind === 'assistant');
      expect(assistantItems).toHaveLength(2);
      if (assistantItems[0].kind === 'assistant') {
        expect(assistantItems[0].parts[0]).toEqual({ kind: 'text', text: 'Turn 1 response' });
      }
      if (assistantItems[1].kind === 'assistant') {
        expect(assistantItems[1].parts[0]).toEqual({ kind: 'text', text: 'Turn 2 response' });
      }
    });

    it('does NOT split on mid-stream user messages during live streaming', () => {
      const events: AgendoEvent[] = [
        { ...base, id: 1, type: 'agent:text-delta', text: 'Working' },
        { ...base, id: 2, type: 'user:message', text: 'msg1' },
        { ...base, id: 3, type: 'agent:text-delta', text: ' on ' },
        { ...base, id: 4, type: 'user:message', text: 'msg2' },
        { ...base, id: 5, type: 'agent:text-delta', text: 'it' },
        { ...base, id: 6, type: 'agent:text', text: 'Working on it' },
      ];
      const items = buildDisplayItems(events, emptyMap);
      const assistantItems = items.filter((i) => i.kind === 'assistant');
      const userItems = items.filter((i) => i.kind === 'user');
      // 1 bubble (no split during streaming), 2 user messages after it
      expect(assistantItems).toHaveLength(1);
      expect(userItems).toHaveLength(2);
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
