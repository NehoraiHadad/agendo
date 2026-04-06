/**
 * Tests for codex-history.ts — maps Codex thread/read response (Turn[]+ThreadItem[])
 * to AgendoEventPayload[] for SSE reconnect fallback.
 */

import { describe, it, expect } from 'vitest';
import { mapCodexThreadToEvents } from '../codex-history';
import type { AgendoEventPayload } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Helper types mirroring Codex thread/read response
// ---------------------------------------------------------------------------

interface MockThread {
  id: string;
  cwd: string;
  turns: MockTurn[];
}

interface MockTurn {
  id: string;
  items: MockThreadItem[];
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string } | null;
}

type MockThreadItem =
  | { type: 'userMessage'; id: string; content: Array<{ type: 'text'; text: string }> }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      exitCode: number | null;
      aggregatedOutput: string | null;
      status: string;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: Array<{ path: string; kind: string }>;
      status: string;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      arguments: Record<string, unknown>;
      result: {
        content?: Array<{ type: string; text?: string }> | null;
        output?: string | null;
      } | null;
      error: { message: string } | null;
      status: string;
    }
  | { type: 'plan'; id: string; text: string }
  | { type: 'contextCompaction'; id: string };

function makeThread(turns: MockTurn[], id = 'thread-1', cwd = '/tmp'): MockThread {
  return { id, cwd, turns };
}

function makeTurn(
  items: MockThreadItem[],
  status: MockTurn['status'] = 'completed',
  error: MockTurn['error'] = null,
  id = 'turn-1',
): MockTurn {
  return { id, items, status, error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapCodexThreadToEvents', () => {
  it('returns empty array for thread with no turns', () => {
    const thread = makeThread([]);
    expect(mapCodexThreadToEvents(thread)).toEqual([]);
  });

  it('maps a userMessage item to user:message', () => {
    const thread = makeThread([
      makeTurn([{ type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: 'Hello' }] }]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const userMsgs = events.filter((e) => e.type === 'user:message');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]).toMatchObject({ type: 'user:message', text: 'Hello' });
  });

  it('maps an agentMessage item to agent:text', () => {
    const thread = makeThread([
      makeTurn([{ type: 'agentMessage', id: 'item-2', text: 'I will help you' }]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const textEvents = events.filter((e) => e.type === 'agent:text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toMatchObject({ type: 'agent:text', text: 'I will help you' });
  });

  it('maps a reasoning item to agent:thinking', () => {
    const thread = makeThread([
      makeTurn([
        {
          type: 'reasoning',
          id: 'item-3',
          summary: ['Thinking about the problem'],
          content: ['Full reasoning content'],
        },
      ]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const thinkingEvents = events.filter((e) => e.type === 'agent:thinking');
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0]).toMatchObject({
      type: 'agent:thinking',
      text: 'Thinking about the problem',
    });
  });

  it('maps commandExecution to agent:tool-start + agent:tool-end', () => {
    const thread = makeThread([
      makeTurn([
        {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'ls -la',
          cwd: '/tmp',
          exitCode: 0,
          aggregatedOutput: 'total 42',
          status: 'completed',
        },
      ]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const toolStarts = events.filter((e) => e.type === 'agent:tool-start');
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]).toMatchObject({
      type: 'agent:tool-start',
      toolUseId: 'cmd-1',
      toolName: 'Bash',
      input: { command: 'ls -la', cwd: '/tmp' },
    });

    const toolEnds = events.filter((e) => e.type === 'agent:tool-end');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]).toMatchObject({
      type: 'agent:tool-end',
      toolUseId: 'cmd-1',
      content: 'total 42',
    });
  });

  it('maps fileChange to agent:tool-start + agent:tool-end', () => {
    const thread = makeThread([
      makeTurn([
        {
          type: 'fileChange',
          id: 'fc-1',
          changes: [{ path: '/tmp/foo.ts', kind: 'update' }],
          status: 'completed',
        },
      ]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const toolStarts = events.filter((e) => e.type === 'agent:tool-start');
    expect(toolStarts).toHaveLength(1);
    expect(
      (toolStarts[0] as Extract<AgendoEventPayload, { type: 'agent:tool-start' }>).toolName,
    ).toBe('FileChange');

    const toolEnds = events.filter((e) => e.type === 'agent:tool-end');
    expect(toolEnds).toHaveLength(1);
  });

  it('maps mcpToolCall to agent:tool-start + agent:tool-end', () => {
    const thread = makeThread([
      makeTurn([
        {
          type: 'mcpToolCall',
          id: 'mcp-1',
          server: 'agendo',
          tool: 'get_my_task',
          arguments: {},
          result: { output: '{"id": "task-1"}' },
          error: null,
          status: 'completed',
        },
      ]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const toolStarts = events.filter((e) => e.type === 'agent:tool-start');
    expect(toolStarts).toHaveLength(1);
    expect(
      (toolStarts[0] as Extract<AgendoEventPayload, { type: 'agent:tool-start' }>).toolName,
    ).toBe('get_my_task');
  });

  it('maps a plan item to agent:text', () => {
    const thread = makeThread([
      makeTurn([{ type: 'plan', id: 'plan-1', text: 'Step 1: Read files\nStep 2: Edit code' }]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const textEvents = events.filter((e) => e.type === 'agent:text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toMatchObject({
      type: 'agent:text',
      text: 'Step 1: Read files\nStep 2: Edit code',
    });
  });

  it('maps contextCompaction to system:compact-start + system:info', () => {
    const thread = makeThread([makeTurn([{ type: 'contextCompaction', id: 'compact-1' }])]);
    const events = mapCodexThreadToEvents(thread);

    const compactStarts = events.filter((e) => e.type === 'system:compact-start');
    expect(compactStarts).toHaveLength(1);

    const infos = events.filter((e) => e.type === 'system:info');
    expect(infos).toHaveLength(1);
  });

  it('emits agent:result at end of each completed turn', () => {
    const thread = makeThread([
      makeTurn([{ type: 'agentMessage', id: 'a-1', text: 'First turn' }], 'completed'),
      makeTurn(
        [{ type: 'agentMessage', id: 'a-2', text: 'Second turn' }],
        'completed',
        null,
        'turn-2',
      ),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const results = events.filter((e) => e.type === 'agent:result');
    expect(results).toHaveLength(2);
  });

  it('emits error result for failed turns', () => {
    const thread = makeThread([makeTurn([], 'failed', { message: 'API rate limit exceeded' })]);
    const events = mapCodexThreadToEvents(thread);

    const results = events.filter((e) => e.type === 'agent:result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'agent:result',
      isError: true,
      errors: ['API rate limit exceeded'],
    });
  });

  it('handles commandExecution with non-zero exit code', () => {
    const thread = makeThread([
      makeTurn([
        {
          type: 'commandExecution',
          id: 'cmd-fail',
          command: 'cat missing.txt',
          cwd: '/tmp',
          exitCode: 1,
          aggregatedOutput: 'No such file',
          status: 'completed',
        },
      ]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const toolEnds = events.filter((e) => e.type === 'agent:tool-end');
    expect(toolEnds).toHaveLength(1);
    expect(
      (toolEnds[0] as Extract<AgendoEventPayload, { type: 'agent:tool-end' }>).content,
    ).toContain('[exit 1]');
  });

  it('handles a full multi-turn conversation', () => {
    const thread = makeThread([
      makeTurn([
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Fix the bug' }] },
        { type: 'reasoning', id: 'r1', summary: ['Analyzing the issue'], content: [] },
        { type: 'agentMessage', id: 'am1', text: 'I see the problem' },
        {
          type: 'commandExecution',
          id: 'cmd1',
          command: 'grep -r "bug" .',
          cwd: '/tmp',
          exitCode: 0,
          aggregatedOutput: 'found it',
          status: 'completed',
        },
      ]),
      makeTurn(
        [
          { type: 'agentMessage', id: 'am2', text: 'Fixed!' },
          {
            type: 'fileChange',
            id: 'fc1',
            changes: [{ path: '/tmp/main.ts', kind: 'update' }],
            status: 'completed',
          },
        ],
        'completed',
        null,
        'turn-2',
      ),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const types = events.map((e) => e.type);
    expect(types).toContain('user:message');
    expect(types).toContain('agent:thinking');
    expect(types).toContain('agent:text');
    expect(types).toContain('agent:tool-start');
    expect(types).toContain('agent:tool-end');
    expect(types).toContain('agent:result');
    // Two turns = two results
    expect(events.filter((e) => e.type === 'agent:result')).toHaveLength(2);
  });

  it('extracts MCP tool result from standard content blocks (not legacy output)', () => {
    const artifactJson = JSON.stringify({
      id: 'abc-123',
      title: 'Test Artifact',
      type: 'html',
    });
    const thread = makeThread([
      makeTurn([
        {
          type: 'mcpToolCall',
          id: 'mcp-1',
          server: 'agendo',
          tool: 'render_artifact',
          arguments: { title: 'Test', content: '<html></html>' },
          result: {
            content: [{ type: 'text', text: artifactJson }],
          },
          error: null,
          status: 'completed',
        },
      ]),
    ]);
    const events = mapCodexThreadToEvents(thread);

    const toolEnd = events.find(
      (e) => e.type === 'agent:tool-end' && (e as { toolUseId: string }).toolUseId === 'mcp-1',
    ) as (AgendoEventPayload & { content: unknown }) | undefined;
    expect(toolEnd).toBeDefined();
    // Content should be the MCP content block array, not an empty string
    expect(toolEnd!.content).toEqual([{ type: 'text', text: artifactJson }]);
  });
});
