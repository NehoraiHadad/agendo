import { describe, it, expect, vi } from 'vitest';
import { mapClaudeJsonToEvents, type ClaudeEventMapperCallbacks } from '../claude-event-mapper';

function makeCallbacks(
  overrides?: Partial<ClaudeEventMapperCallbacks>,
): ClaudeEventMapperCallbacks {
  return {
    clearDeltaBuffers: vi.fn(),
    appendDelta: vi.fn(),
    appendThinkingDelta: vi.fn(),
    onResultStats: vi.fn(),
    ...overrides,
  };
}

describe('mapClaudeJsonToEvents — stream_event / message_start', () => {
  it('calls onMessageStart with per-call usage from message_start', () => {
    const onMessageStart = vi.fn();
    const callbacks = makeCallbacks({ onMessageStart });

    const parsed = {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-6',
          id: 'msg_123',
          usage: {
            input_tokens: 7,
            cache_read_input_tokens: 122684,
            cache_creation_input_tokens: 26488,
            output_tokens: 0,
          },
        },
      },
    };

    const result = mapClaudeJsonToEvents(parsed, callbacks);

    expect(result).toEqual([]); // message_start produces no AgendoEvent
    expect(onMessageStart).toHaveBeenCalledOnce();
    expect(onMessageStart).toHaveBeenCalledWith({
      inputTokens: 7,
      cacheReadInputTokens: 122684,
      cacheCreationInputTokens: 26488,
    });
  });

  it('does not crash when onMessageStart is not provided', () => {
    const callbacks = makeCallbacks(); // no onMessageStart

    const parsed = {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 3,
            cache_read_input_tokens: 50000,
            cache_creation_input_tokens: 10000,
          },
        },
      },
    };

    expect(() => mapClaudeJsonToEvents(parsed, callbacks)).not.toThrow();
  });

  it('handles missing usage fields gracefully (defaults to 0)', () => {
    const onMessageStart = vi.fn();
    const callbacks = makeCallbacks({ onMessageStart });

    const parsed = {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          usage: {
            // cache fields absent — older API response without caching
            input_tokens: 1200,
          },
        },
      },
    };

    mapClaudeJsonToEvents(parsed, callbacks);

    expect(onMessageStart).toHaveBeenCalledWith({
      inputTokens: 1200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('does not call onMessageStart when message_start has no usage', () => {
    const onMessageStart = vi.fn();
    const callbacks = makeCallbacks({ onMessageStart });

    const parsed = {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          // no usage field
        },
      },
    };

    mapClaudeJsonToEvents(parsed, callbacks);

    expect(onMessageStart).not.toHaveBeenCalled();
  });

  it('still handles content_block_delta text_delta after adding message_start', () => {
    const appendDelta = vi.fn();
    const callbacks = makeCallbacks({ appendDelta });

    const parsed = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    };

    const result = mapClaudeJsonToEvents(parsed, callbacks);

    expect(result).toEqual([]);
    expect(appendDelta).toHaveBeenCalledWith('hello');
  });
});

describe('mapClaudeJsonToEvents — result', () => {
  it('maps result event with modelUsage including cache fields', () => {
    const onResultStats = vi.fn();
    const callbacks = makeCallbacks({ onResultStats });

    const parsed = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4500,
      num_turns: 3,
      total_cost_usd: 0.05,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 10,
          outputTokens: 500,
          cacheReadInputTokens: 173484,
          cacheCreationInputTokens: 27247,
          costUSD: 0.05,
          contextWindow: 200000,
          maxOutputTokens: 32000,
        },
      },
    };

    const result = mapClaudeJsonToEvents(parsed, callbacks);

    expect(result).toHaveLength(1);
    const event = result[0];
    expect(event.type).toBe('agent:result');
    if (event.type === 'agent:result') {
      expect(event.modelUsage?.['claude-sonnet-4-6']?.cacheReadInputTokens).toBe(173484);
      expect(event.modelUsage?.['claude-sonnet-4-6']?.cacheCreationInputTokens).toBe(27247);
      expect(event.modelUsage?.['claude-sonnet-4-6']?.contextWindow).toBe(200000);
    }
    expect(onResultStats).toHaveBeenCalledWith(0.05, 3);
  });
});

describe('mapClaudeJsonToEvents — system/init', () => {
  it('maps system init to session:init', () => {
    const callbacks = makeCallbacks();
    const parsed = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc',
      slash_commands: ['compact', 'clear'],
      mcp_servers: [],
      model: 'claude-sonnet-4-6',
    };

    const result = mapClaudeJsonToEvents(parsed, callbacks);

    expect(result).toEqual([
      {
        type: 'session:init',
        sessionRef: 'sess-abc',
        slashCommands: ['compact', 'clear'],
        mcpServers: [],
        model: 'claude-sonnet-4-6',
        apiKeySource: undefined,
        cwd: undefined,
        tools: undefined,
        permissionMode: undefined,
      },
    ]);
  });
});
