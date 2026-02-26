import { describe, it, expect } from 'vitest';
import { mapCodexJsonToEvents, type CodexEvent } from '../codex-event-mapper';

describe('mapCodexJsonToEvents', () => {
  // -----------------------------------------------------------------------
  // thread.started → session:init
  // -----------------------------------------------------------------------
  it('maps thread.started to session:init', () => {
    const event: CodexEvent = {
      type: 'thread.started',
      thread_id: 'thread_abc123',
      thread_created_at: '2026-02-25T10:00:00Z',
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'session:init',
        sessionRef: 'thread_abc123',
        slashCommands: [],
        mcpServers: [],
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // turn.started → [] (no emitted event, only thinkingCallback)
  // -----------------------------------------------------------------------
  it('maps turn.started to empty array', () => {
    const event: CodexEvent = { type: 'turn.started' };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // item.started type=command_execution → agent:tool-start
  // -----------------------------------------------------------------------
  it('maps item.started with command_execution to agent:tool-start', () => {
    const event: CodexEvent = {
      type: 'item.started',
      item: {
        type: 'command_execution',
        id: 'item_001',
        call_id: 'call_001',
        command: 'ls -la',
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-start',
        toolUseId: 'call_001',
        toolName: 'Bash',
        input: { command: 'ls -la' },
      },
    ]);
  });

  it('maps item.started with file_search to agent:tool-start', () => {
    const event: CodexEvent = {
      type: 'item.started',
      item: {
        type: 'file_search',
        id: 'item_002',
        call_id: 'call_002',
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-start',
        toolUseId: 'call_002',
        toolName: 'FileSearch',
        input: {},
      },
    ]);
  });

  it('maps item.started with non-tool types to empty array', () => {
    const event: CodexEvent = {
      type: 'item.started',
      item: { type: 'reasoning', id: 'item_003' },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // item.completed type=reasoning → agent:thinking
  // -----------------------------------------------------------------------
  it('maps item.completed with reasoning to agent:thinking', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'reasoning',
        id: 'item_010',
        content: [{ type: 'reasoning_summary', text: 'Analyzing the code structure...' }],
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:thinking', text: 'Analyzing the code structure...' }]);
  });

  it('maps item.completed with reasoning and multiple content blocks', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'reasoning',
        id: 'item_011',
        content: [
          { type: 'reasoning_summary', text: 'First thought.' },
          { type: 'reasoning_summary', text: 'Second thought.' },
        ],
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:thinking', text: 'First thought.\nSecond thought.' }]);
  });

  // -----------------------------------------------------------------------
  // item.completed type=agent_message → agent:text
  // -----------------------------------------------------------------------
  it('maps item.completed with agent_message to agent:text', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        id: 'item_020',
        content: [{ type: 'output_text', text: 'Here is the fix I made.' }],
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: 'Here is the fix I made.' }]);
  });

  it('maps agent_message with multiple output_text blocks', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        id: 'item_021',
        content: [
          { type: 'output_text', text: 'Part 1.' },
          { type: 'output_text', text: 'Part 2.' },
        ],
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: 'Part 1.\nPart 2.' }]);
  });

  // -----------------------------------------------------------------------
  // item.completed type=command_execution → agent:tool-end
  // -----------------------------------------------------------------------
  it('maps item.completed with command_execution to agent:tool-end', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'item_030',
        call_id: 'call_030',
        command: 'cat file.txt',
        exit_code: 0,
        stdout: 'file contents here',
        stderr: '',
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-end',
        toolUseId: 'call_030',
        content: 'file contents here',
      },
    ]);
  });

  it('maps command_execution with non-zero exit and stderr to tool-end with stderr', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'item_031',
        call_id: 'call_031',
        command: 'cat nonexistent.txt',
        exit_code: 1,
        stdout: '',
        stderr: 'No such file or directory',
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-end',
        toolUseId: 'call_031',
        content: '[exit 1] No such file or directory',
      },
    ]);
  });

  it('maps item.completed with file_search to agent:tool-end', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'file_search',
        id: 'item_032',
        call_id: 'call_032',
        results: ['file1.ts', 'file2.ts'],
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-end',
        toolUseId: 'call_032',
        content: JSON.stringify(['file1.ts', 'file2.ts']),
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // item.completed type=mcp_call → agent:tool-end
  // -----------------------------------------------------------------------
  it('maps item.completed with mcp_call to agent:tool-end', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'mcp_call',
        id: 'item_040',
        call_id: 'call_040',
        content: [{ type: 'output_text', text: 'MCP result here' }],
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-end',
        toolUseId: 'call_040',
        content: 'MCP result here',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // item.started type=mcp_call → agent:tool-start
  // -----------------------------------------------------------------------
  it('maps item.started with mcp_call to agent:tool-start', () => {
    const event: CodexEvent = {
      type: 'item.started',
      item: {
        type: 'mcp_call',
        id: 'item_041',
        call_id: 'call_041',
        name: 'mcp__agendo__get_task',
        arguments: '{"taskId":"abc"}',
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-start',
        toolUseId: 'call_041',
        toolName: 'mcp__agendo__get_task',
        input: { taskId: 'abc' },
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // turn.completed → agent:result with usage
  // -----------------------------------------------------------------------
  it('maps turn.completed to agent:result with usage tokens', () => {
    const event: CodexEvent = {
      type: 'turn.completed',
      usage: {
        input_tokens: 1500,
        output_tokens: 300,
        cached_input_tokens: 500,
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        modelUsage: {
          codex: {
            inputTokens: 1500,
            outputTokens: 300,
            cacheReadInputTokens: 500,
            costUSD: 0,
          },
        },
      },
    ]);
  });

  it('maps turn.completed without usage to agent:result with defaults', () => {
    const event: CodexEvent = { type: 'turn.completed' };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // turn.failed → agent:result (isError) + system:error
  // -----------------------------------------------------------------------
  it('maps turn.failed to agent:result (isError) + system:error', () => {
    const event: CodexEvent = {
      type: 'turn.failed',
      error: { message: 'Rate limit exceeded', code: 'rate_limit' },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        isError: true,
        subtype: 'rate_limit',
        errors: ['Rate limit exceeded'],
      },
      {
        type: 'system:error',
        message: 'Codex turn failed: Rate limit exceeded',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // error → system:error
  // -----------------------------------------------------------------------
  it('maps error to system:error', () => {
    const event: CodexEvent = {
      type: 'error',
      error: { message: 'Connection lost' },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([{ type: 'system:error', message: 'Codex error: Connection lost' }]);
  });

  // -----------------------------------------------------------------------
  // unknown event types → empty array
  // -----------------------------------------------------------------------
  it('returns empty array for unknown event types', () => {
    const event = { type: 'unknown.event' } as unknown as CodexEvent;
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // edge: missing fields handled gracefully
  // -----------------------------------------------------------------------
  it('handles item.completed with empty content array', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        id: 'item_050',
        content: [],
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: '' }]);
  });

  it('handles item.completed command_execution with no stdout/stderr', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'item_051',
        call_id: 'call_051',
        command: 'true',
        exit_code: 0,
      },
    };
    const result = mapCodexJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-end',
        toolUseId: 'call_051',
        content: '',
      },
    ]);
  });
});
