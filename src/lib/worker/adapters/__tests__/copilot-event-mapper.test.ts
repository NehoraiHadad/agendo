import { describe, it, expect } from 'vitest';
import { mapCopilotJsonToEvents, type CopilotEvent } from '../copilot-event-mapper';

describe('mapCopilotJsonToEvents', () => {
  // copilot:text → agent:text
  it('maps copilot:text to agent:text', () => {
    const event: CopilotEvent = { type: 'copilot:text', text: 'Hello from Copilot!' };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: 'Hello from Copilot!' }]);
  });

  it('maps copilot:text with empty text', () => {
    const event: CopilotEvent = { type: 'copilot:text', text: '' };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: '' }]);
  });

  // copilot:thinking → agent:thinking
  it('maps copilot:thinking to agent:thinking', () => {
    const event: CopilotEvent = { type: 'copilot:thinking', text: 'Let me think...' };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:thinking', text: 'Let me think...' }]);
  });

  // copilot:text-delta → agent:text-delta
  it('maps copilot:text-delta to agent:text-delta', () => {
    const event: CopilotEvent = { type: 'copilot:text-delta', text: 'streaming...' };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text-delta', text: 'streaming...' }]);
  });

  // copilot:thinking-delta → agent:thinking-delta
  it('maps copilot:thinking-delta to agent:thinking-delta', () => {
    const event: CopilotEvent = { type: 'copilot:thinking-delta', text: 'thinking stream...' };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:thinking-delta', text: 'thinking stream...' }]);
  });

  // copilot:tool-start → agent:tool-start
  it('maps copilot:tool-start to agent:tool-start', () => {
    const event: CopilotEvent = {
      type: 'copilot:tool-start',
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      toolUseId: 'tool-001',
    };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-start',
        toolUseId: 'tool-001',
        toolName: 'Bash',
        input: { command: 'ls -la' },
      },
    ]);
  });

  // copilot:tool-end → agent:tool-end
  it('maps copilot:tool-end to agent:tool-end', () => {
    const event: CopilotEvent = { type: 'copilot:tool-end', toolUseId: 'tool-001' };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:tool-end', toolUseId: 'tool-001', content: '' }]);
  });

  // copilot:turn-complete → agent:result
  it('maps copilot:turn-complete to agent:result', () => {
    const event: CopilotEvent = { type: 'copilot:turn-complete', result: { done: true } };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:result', costUsd: null, turns: 1, durationMs: null }]);
  });

  it('maps copilot:turn-complete with usage to agent:result with modelUsage', () => {
    const event: CopilotEvent = {
      type: 'copilot:turn-complete',
      result: { usage: { inputTokens: 1000, outputTokens: 500 } },
    };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        modelUsage: { copilot: { inputTokens: 1000, outputTokens: 500, costUSD: 0 } },
      },
    ]);
  });

  // copilot:turn-error → agent:result (isError) + system:error
  it('maps copilot:turn-error to error events', () => {
    const event: CopilotEvent = { type: 'copilot:turn-error', message: 'Rate limit exceeded' };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        isError: true,
        errors: ['Rate limit exceeded'],
      },
      { type: 'system:error', message: 'Copilot turn failed: Rate limit exceeded' },
    ]);
  });

  // copilot:init → session:init
  it('maps copilot:init to session:init', () => {
    const event: CopilotEvent = {
      type: 'copilot:init',
      model: 'claude-sonnet-4.6',
      sessionId: 'sess-1',
    };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'session:init',
        sessionRef: 'sess-1',
        slashCommands: [],
        mcpServers: [],
        model: 'claude-sonnet-4.6',
      },
    ]);
  });

  // copilot:plan → agent:plan
  it('maps copilot:plan to agent:plan', () => {
    const event: CopilotEvent = {
      type: 'copilot:plan',
      entries: [{ content: 'Step 1', priority: 'high', status: 'pending' }],
    };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:plan',
        entries: [{ content: 'Step 1', priority: 'high', status: 'pending' }],
      },
    ]);
  });

  // copilot:mode-change → session:mode-change
  it('maps copilot:mode-change to session:mode-change', () => {
    const event: CopilotEvent = { type: 'copilot:mode-change', modeId: 'yolo' };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'session:mode-change', mode: 'bypassPermissions' }]);
  });

  // copilot:usage → agent:usage
  it('maps copilot:usage to agent:usage', () => {
    const event: CopilotEvent = { type: 'copilot:usage', used: 5000, size: 128000 };
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:usage', used: 5000, size: 128000 }]);
  });

  // NO copilot:commands case (dropped from Copilot)

  // unknown → empty array
  it('returns empty array for unknown event types', () => {
    const event = { type: 'unknown' } as unknown as CopilotEvent;
    const result = mapCopilotJsonToEvents(event);
    expect(result).toEqual([]);
  });
});
