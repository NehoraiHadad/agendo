import { describe, it, expect } from 'vitest';
import { mapOpenCodeJsonToEvents, type OpenCodeEvent } from '../opencode-event-mapper';

describe('mapOpenCodeJsonToEvents', () => {
  // -----------------------------------------------------------------------
  // opencode:text → agent:text
  // -----------------------------------------------------------------------
  it('maps opencode:text to agent:text', () => {
    const event: OpenCodeEvent = { type: 'opencode:text', text: 'Hello from OpenCode!' };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: 'Hello from OpenCode!' }]);
  });

  it('maps opencode:text with empty text to agent:text', () => {
    const event: OpenCodeEvent = { type: 'opencode:text', text: '' };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: '' }]);
  });

  // -----------------------------------------------------------------------
  // opencode:text-delta → agent:text-delta
  // -----------------------------------------------------------------------
  it('maps opencode:text-delta to agent:text-delta', () => {
    const event: OpenCodeEvent = { type: 'opencode:text-delta', text: 'streaming chunk' };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text-delta', text: 'streaming chunk' }]);
  });

  // -----------------------------------------------------------------------
  // opencode:thinking → agent:thinking
  // -----------------------------------------------------------------------
  it('maps opencode:thinking to agent:thinking', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:thinking',
      text: 'Let me think about this...',
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:thinking', text: 'Let me think about this...' }]);
  });

  // -----------------------------------------------------------------------
  // opencode:thinking-delta → agent:thinking-delta
  // -----------------------------------------------------------------------
  it('maps opencode:thinking-delta to agent:thinking-delta', () => {
    const event: OpenCodeEvent = { type: 'opencode:thinking-delta', text: 'reasoning...' };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:thinking-delta', text: 'reasoning...' }]);
  });

  // -----------------------------------------------------------------------
  // opencode:tool-start → agent:tool-start
  // -----------------------------------------------------------------------
  it('maps opencode:tool-start to agent:tool-start', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:tool-start',
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      toolUseId: 'tool-001',
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-start',
        toolUseId: 'tool-001',
        toolName: 'Bash',
        input: { command: 'ls -la' },
      },
    ]);
  });

  it('maps opencode:tool-start with missing fields to defaults', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:tool-start',
      toolName: 'unknown',
      toolInput: {},
      toolUseId: '',
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-start',
        toolUseId: '',
        toolName: 'unknown',
        input: {},
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // opencode:tool-end → agent:tool-end
  // -----------------------------------------------------------------------
  it('maps opencode:tool-end to agent:tool-end', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:tool-end',
      toolUseId: 'tool-001',
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-end',
        toolUseId: 'tool-001',
        content: '',
      },
    ]);
  });

  it('maps opencode:tool-end with resultText to agent:tool-end with content', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:tool-end',
      toolUseId: 'tool-002',
      resultText: 'file content here',
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-end',
        toolUseId: 'tool-002',
        content: 'file content here',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // opencode:turn-complete → agent:result
  // -----------------------------------------------------------------------
  it('maps opencode:turn-complete to agent:result', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:turn-complete',
      result: { sessionId: 'sess-1', done: true },
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
      },
    ]);
  });

  it('maps opencode:turn-complete with usage to agent:result with modelUsage', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:turn-complete',
      result: {
        sessionId: 'sess-1',
        usage: { inputTokens: 1000, outputTokens: 500 },
      },
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        modelUsage: {
          opencode: {
            inputTokens: 1000,
            outputTokens: 500,
            costUSD: 0,
          },
        },
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // opencode:turn-error → agent:result (isError) + system:error
  // -----------------------------------------------------------------------
  it('maps opencode:turn-error to agent:result (isError) + system:error', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:turn-error',
      message: 'Rate limit exceeded',
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        isError: true,
        errors: ['Rate limit exceeded'],
      },
      {
        type: 'system:error',
        message: 'OpenCode turn failed: Rate limit exceeded',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // opencode:init → session:init
  // -----------------------------------------------------------------------
  it('maps opencode:init to session:init', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:init',
      model: 'anthropic/claude-sonnet-4-5',
      sessionId: 'sess-abc-123',
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'session:init',
        sessionRef: 'sess-abc-123',
        slashCommands: [],
        mcpServers: [],
        model: 'anthropic/claude-sonnet-4-5',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // opencode:plan → agent:plan
  // -----------------------------------------------------------------------
  it('maps opencode:plan to agent:plan', () => {
    const event: OpenCodeEvent = {
      type: 'opencode:plan',
      entries: [
        { content: 'Step 1: analyze', priority: 'high', status: 'completed' },
        { content: 'Step 2: implement', priority: 'medium', status: 'pending' },
      ],
    };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:plan',
        entries: [
          { content: 'Step 1: analyze', priority: 'high', status: 'completed' },
          { content: 'Step 2: implement', priority: 'medium', status: 'pending' },
        ],
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // opencode:mode-change → session:mode-change
  // -----------------------------------------------------------------------
  it('maps opencode:mode-change (general) to session:mode-change (default)', () => {
    const event: OpenCodeEvent = { type: 'opencode:mode-change', modeId: 'general' };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'session:mode-change', mode: 'default' }]);
  });

  it('maps opencode:mode-change (plan) to session:mode-change (plan)', () => {
    const event: OpenCodeEvent = { type: 'opencode:mode-change', modeId: 'plan' };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'session:mode-change', mode: 'plan' }]);
  });

  it('maps opencode:mode-change (build) to session:mode-change (build)', () => {
    const event: OpenCodeEvent = { type: 'opencode:mode-change', modeId: 'build' };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'session:mode-change', mode: 'build' }]);
  });

  it('maps opencode:mode-change with unknown modeId to passthrough', () => {
    const event: OpenCodeEvent = { type: 'opencode:mode-change', modeId: 'explore' };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'session:mode-change', mode: 'explore' }]);
  });

  // -----------------------------------------------------------------------
  // opencode:usage → agent:usage
  // -----------------------------------------------------------------------
  it('maps opencode:usage to agent:usage', () => {
    const event: OpenCodeEvent = { type: 'opencode:usage', used: 4000, size: 128000 };
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:usage', used: 4000, size: 128000 }]);
  });

  // -----------------------------------------------------------------------
  // No opencode:commands — OpenCode has no slash commands
  // -----------------------------------------------------------------------
  it('does not have a commands event type (OpenCode has no slash commands)', () => {
    // Verify that an unknown type returns empty array
    const event = { type: 'unknown' } as unknown as OpenCodeEvent;
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // unknown event types → empty array
  // -----------------------------------------------------------------------
  it('returns empty array for unknown event types', () => {
    const event = { type: 'opencode:unknown-future-event' } as unknown as OpenCodeEvent;
    const result = mapOpenCodeJsonToEvents(event);
    expect(result).toEqual([]);
  });
});
