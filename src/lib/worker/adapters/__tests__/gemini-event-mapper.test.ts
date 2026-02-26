import { describe, it, expect } from 'vitest';
import { mapGeminiJsonToEvents, type GeminiEvent } from '../gemini-event-mapper';

describe('mapGeminiJsonToEvents', () => {
  // -----------------------------------------------------------------------
  // gemini:text → agent:text
  // -----------------------------------------------------------------------
  it('maps gemini:text to agent:text', () => {
    const event: GeminiEvent = { type: 'gemini:text', text: 'Hello from Gemini!' };
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: 'Hello from Gemini!' }]);
  });

  it('maps gemini:text with empty text to agent:text', () => {
    const event: GeminiEvent = { type: 'gemini:text', text: '' };
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:text', text: '' }]);
  });

  // -----------------------------------------------------------------------
  // gemini:thinking → agent:thinking
  // -----------------------------------------------------------------------
  it('maps gemini:thinking to agent:thinking', () => {
    const event: GeminiEvent = {
      type: 'gemini:thinking',
      text: 'Let me think about this...',
    };
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([{ type: 'agent:thinking', text: 'Let me think about this...' }]);
  });

  // -----------------------------------------------------------------------
  // gemini:tool-start → agent:tool-start
  // -----------------------------------------------------------------------
  it('maps gemini:tool-start to agent:tool-start', () => {
    const event: GeminiEvent = {
      type: 'gemini:tool-start',
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      toolUseId: 'tool-001',
    };
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-start',
        toolUseId: 'tool-001',
        toolName: 'Bash',
        input: { command: 'ls -la' },
      },
    ]);
  });

  it('maps gemini:tool-start with missing fields to defaults', () => {
    const event: GeminiEvent = {
      type: 'gemini:tool-start',
      toolName: 'unknown',
      toolInput: {},
      toolUseId: '',
    };
    const result = mapGeminiJsonToEvents(event);
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
  // gemini:tool-end → agent:tool-end
  // -----------------------------------------------------------------------
  it('maps gemini:tool-end to agent:tool-end', () => {
    const event: GeminiEvent = {
      type: 'gemini:tool-end',
      toolUseId: 'tool-001',
    };
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:tool-end',
        toolUseId: 'tool-001',
        content: '',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // gemini:turn-complete → agent:result
  // -----------------------------------------------------------------------
  it('maps gemini:turn-complete to agent:result', () => {
    const event: GeminiEvent = {
      type: 'gemini:turn-complete',
      result: { sessionId: 'sess-1', done: true },
    };
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
      },
    ]);
  });

  it('maps gemini:turn-complete with usage to agent:result with modelUsage', () => {
    const event: GeminiEvent = {
      type: 'gemini:turn-complete',
      result: {
        sessionId: 'sess-1',
        usage: { inputTokens: 1000, outputTokens: 500 },
      },
    };
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        modelUsage: {
          gemini: {
            inputTokens: 1000,
            outputTokens: 500,
            costUSD: 0,
          },
        },
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // gemini:turn-error → agent:result (isError) + system:error
  // -----------------------------------------------------------------------
  it('maps gemini:turn-error to agent:result (isError) + system:error', () => {
    const event: GeminiEvent = {
      type: 'gemini:turn-error',
      message: 'Rate limit exceeded',
    };
    const result = mapGeminiJsonToEvents(event);
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
        message: 'Gemini turn failed: Rate limit exceeded',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // gemini:retry → system:info
  // -----------------------------------------------------------------------
  it('maps gemini:retry to system:info', () => {
    const event: GeminiEvent = {
      type: 'gemini:retry',
      message: 'Rate limited (attempt 1/3). Retrying in 15s...',
    };
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([
      {
        type: 'system:info',
        message: 'Rate limited (attempt 1/3). Retrying in 15s...',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // unknown event types → empty array
  // -----------------------------------------------------------------------
  it('returns empty array for unknown event types', () => {
    const event = { type: 'unknown' } as unknown as GeminiEvent;
    const result = mapGeminiJsonToEvents(event);
    expect(result).toEqual([]);
  });
});
