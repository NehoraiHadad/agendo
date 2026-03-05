import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll import after the module exists — for now these are the planned interfaces
import {
  SessionDataPipeline,
  enrichResultPayload,
  type DataPipelineDeps,
} from '../session-data-pipeline';
import type { AgendoEventPayload, AgendoEvent } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<DataPipelineDeps>): DataPipelineDeps {
  return {
    sessionId: 'test-session-1',
    logWriter: { write: vi.fn() },
    adapter: {
      mapJsonToEvents: undefined,
      preProcessLine: undefined,
      lastAssistantUuid: undefined,
    },
    approvalHandler: {
      isSuppressedToolEnd: vi.fn().mockReturnValue(false),
      isPendingHumanResponse: vi.fn().mockReturnValue(false),
      suppressToolStart: vi.fn(),
      checkForHumanResponseBlocks: vi.fn(),
    },
    activityTracker: {
      clearDeltaBuffers: vi.fn(),
      appendDelta: vi.fn(),
      appendThinkingDelta: vi.fn(),
    },
    activeToolUseIds: new Set<string>(),
    emitEvent: vi.fn().mockResolvedValue({
      id: 1,
      sessionId: 'test-session-1',
      ts: Date.now(),
      type: 'agent:text',
      text: '',
    } as AgendoEvent),
    onEmittedEvent: vi.fn().mockResolvedValue(undefined),
    mapClaudeJson: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// enrichResultPayload (pure function)
// ---------------------------------------------------------------------------

describe('enrichResultPayload', () => {
  it('passes through non-result payloads unchanged', () => {
    const payload: AgendoEventPayload = { type: 'agent:text', text: 'hello' };
    const result = enrichResultPayload(payload, null, undefined);
    expect(result).toEqual(payload);
  });

  it('adds perCallContextStats to agent:result when provided', () => {
    const payload: AgendoEventPayload = {
      type: 'agent:result',
      costUsd: 0.01,
      turns: 1,
      durationMs: 100,
    };
    const stats = { inputTokens: 100, cacheReadInputTokens: 50, cacheCreationInputTokens: 20 };
    const result = enrichResultPayload(payload, stats, undefined);
    expect(result).toMatchObject({
      type: 'agent:result',
      perCallContextStats: stats,
    });
  });

  it('adds messageUuid to agent:result when provided', () => {
    const payload: AgendoEventPayload = {
      type: 'agent:result',
      costUsd: null,
      turns: null,
      durationMs: null,
    };
    const result = enrichResultPayload(payload, null, 'uuid-123');
    expect(result).toMatchObject({
      type: 'agent:result',
      messageUuid: 'uuid-123',
    });
  });

  it('adds both perCallContextStats and messageUuid when both provided', () => {
    const payload: AgendoEventPayload = {
      type: 'agent:result',
      costUsd: 0.02,
      turns: 2,
      durationMs: 200,
    };
    const stats = { inputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const result = enrichResultPayload(payload, stats, 'uuid-456');
    expect(result).toMatchObject({
      perCallContextStats: stats,
      messageUuid: 'uuid-456',
    });
  });
});

// ---------------------------------------------------------------------------
// SessionDataPipeline
// ---------------------------------------------------------------------------

describe('SessionDataPipeline', () => {
  let deps: DataPipelineDeps;
  let pipeline: SessionDataPipeline;

  beforeEach(() => {
    deps = makeDeps();
    pipeline = new SessionDataPipeline(deps);
  });

  // -------------------------------------------------------------------------
  // NDJSON line buffering
  // -------------------------------------------------------------------------

  describe('line buffering', () => {
    it('buffers partial lines until a newline arrives', async () => {
      // First chunk has no trailing newline — should be buffered
      await pipeline.processChunk('{"type":"assis');
      expect(deps.emitEvent).not.toHaveBeenCalled();

      // Second chunk completes the line
      deps.mapClaudeJson = vi.fn().mockReturnValue([{ type: 'agent:text', text: 'hi' }]);
      await pipeline.processChunk('tant"}\n');
      expect(deps.emitEvent).toHaveBeenCalled();
    });

    it('processes multiple complete lines in a single chunk', async () => {
      const events1: AgendoEventPayload[] = [{ type: 'agent:text', text: 'line1' }];
      const events2: AgendoEventPayload[] = [{ type: 'agent:text', text: 'line2' }];
      deps.mapClaudeJson = vi.fn().mockReturnValueOnce(events1).mockReturnValueOnce(events2);

      await pipeline.processChunk('{"a":1}\n{"b":2}\n');
      expect(deps.emitEvent).toHaveBeenCalledTimes(2);
    });

    it('skips empty lines', async () => {
      await pipeline.processChunk('\n\n\n');
      expect(deps.emitEvent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Non-JSON text → agent:text
  // -------------------------------------------------------------------------

  describe('non-JSON text', () => {
    it('emits agent:text for lines not starting with {', async () => {
      await pipeline.processChunk('Hello world\n');
      expect(deps.emitEvent).toHaveBeenCalledWith({ type: 'agent:text', text: 'Hello world' });
    });

    it('emits system:info for lines that look like JSON but fail to parse', async () => {
      await pipeline.processChunk('{invalid json}\n');
      expect(deps.emitEvent).toHaveBeenCalledWith({
        type: 'system:info',
        message: '{invalid json}',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Approval-gated tool suppression
  // -------------------------------------------------------------------------

  describe('approval-gated tool suppression', () => {
    it('suppresses tool-start for approval-gated tools', async () => {
      const toolStart: AgendoEventPayload = {
        type: 'agent:tool-start',
        toolUseId: 'tu-1',
        toolName: 'ExitPlanMode',
        input: {},
      };
      deps.mapClaudeJson = vi.fn().mockReturnValue([toolStart]);

      await pipeline.processChunk('{"type":"tool"}\n');

      // emitEvent should NOT have been called for the suppressed tool
      expect(deps.emitEvent).not.toHaveBeenCalled();
      // But suppressToolStart should have been called
      expect(deps.approvalHandler.suppressToolStart).toHaveBeenCalledWith('tu-1');
      // And the toolUseId should be tracked
      expect(deps.activeToolUseIds.has('tu-1')).toBe(true);
    });

    it('suppresses tool-end for previously suppressed tools', async () => {
      const toolEnd: AgendoEventPayload = {
        type: 'agent:tool-end',
        toolUseId: 'tu-2',
        content: 'done',
      };
      deps.mapClaudeJson = vi.fn().mockReturnValue([toolEnd]);
      (deps.approvalHandler.isSuppressedToolEnd as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await pipeline.processChunk('{"type":"tool_end"}\n');
      expect(deps.emitEvent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Interactive tool suppression (AskUserQuestion)
  // -------------------------------------------------------------------------

  describe('interactive tool suppression', () => {
    it('suppresses tool-end for pending human response tools', async () => {
      const toolEnd: AgendoEventPayload = {
        type: 'agent:tool-end',
        toolUseId: 'tu-human',
        content: 'error',
      };
      deps.mapClaudeJson = vi.fn().mockReturnValue([toolEnd]);
      (deps.approvalHandler.isPendingHumanResponse as ReturnType<typeof vi.fn>).mockReturnValue(
        true,
      );

      await pipeline.processChunk('{"x":1}\n');
      expect(deps.emitEvent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // enrichResultPayload integration
  // -------------------------------------------------------------------------

  describe('result enrichment', () => {
    it('enriches agent:result with per-call context stats', async () => {
      const resultPayload: AgendoEventPayload = {
        type: 'agent:result',
        costUsd: 0.05,
        turns: 3,
        durationMs: 500,
      };
      deps.mapClaudeJson = vi.fn().mockReturnValue([resultPayload]);
      deps.adapter.lastAssistantUuid = 'uuid-abc';

      // Set per-call stats via the pipeline's public method
      pipeline.setPerCallContextStats({
        inputTokens: 300,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
      });

      await pipeline.processChunk('{"type":"result"}\n');

      expect(deps.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent:result',
          perCallContextStats: {
            inputTokens: 300,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 50,
          },
          messageUuid: 'uuid-abc',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // flushBuffer
  // -------------------------------------------------------------------------

  describe('flushBuffer', () => {
    it('returns empty string when buffer is empty', () => {
      expect(pipeline.flushBuffer()).toBe('');
    });

    it('returns accumulated text and clears the buffer', async () => {
      // Push a partial chunk (no trailing newline)
      await pipeline.processChunk('partial text');
      const flushed = pipeline.flushBuffer();
      expect(flushed).toBe('partial text');

      // Buffer should now be empty
      expect(pipeline.flushBuffer()).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Delegation to adapter.mapJsonToEvents
  // -------------------------------------------------------------------------

  describe('adapter delegation', () => {
    it('uses adapter.mapJsonToEvents when available', async () => {
      const customEvents: AgendoEventPayload[] = [{ type: 'agent:text', text: 'custom' }];
      deps.adapter.mapJsonToEvents = vi.fn().mockReturnValue(customEvents);

      await pipeline.processChunk('{"type":"custom"}\n');

      expect(deps.adapter.mapJsonToEvents).toHaveBeenCalled();
      expect(deps.mapClaudeJson).not.toHaveBeenCalled();
      expect(deps.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'agent:text', text: 'custom' }),
      );
    });

    it('falls back to mapClaudeJson when adapter has no mapJsonToEvents', async () => {
      deps.adapter.mapJsonToEvents = undefined;
      deps.mapClaudeJson = vi.fn().mockReturnValue([{ type: 'agent:text', text: 'claude' }]);

      await pipeline.processChunk('{"type":"assistant"}\n');

      expect(deps.mapClaudeJson).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Writes raw chunk to log
  // -------------------------------------------------------------------------

  describe('log writing', () => {
    it('writes raw chunk to logWriter before processing', async () => {
      await pipeline.processChunk('some data\n');
      expect(deps.logWriter.write).toHaveBeenCalledWith('some data\n', 'stdout');
    });
  });

  // -------------------------------------------------------------------------
  // Calls onEmittedEvent after emitting
  // -------------------------------------------------------------------------

  describe('post-emit callback', () => {
    it('calls onEmittedEvent for each emitted event', async () => {
      const payload: AgendoEventPayload = { type: 'agent:text', text: 'test' };
      deps.mapClaudeJson = vi.fn().mockReturnValue([payload]);

      const fakeEvent = {
        id: 1,
        sessionId: 'test-session-1',
        ts: Date.now(),
        type: 'agent:text' as const,
        text: 'test',
      };
      (deps.emitEvent as ReturnType<typeof vi.fn>).mockResolvedValue(fakeEvent);

      await pipeline.processChunk('{"a":1}\n');

      expect(deps.onEmittedEvent).toHaveBeenCalledWith(fakeEvent);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('continues processing other lines when mapJsonToEvents throws', async () => {
      const goodPayload: AgendoEventPayload = { type: 'agent:text', text: 'good' };
      deps.mapClaudeJson = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('parse fail');
        })
        .mockReturnValueOnce([goodPayload]);

      await pipeline.processChunk('{"bad":1}\n{"good":1}\n');

      // Only the second line should produce an emit
      expect(deps.emitEvent).toHaveBeenCalledTimes(1);
      expect(deps.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'agent:text', text: 'good' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // lastContextWindow and agent:usage
  // -------------------------------------------------------------------------

  describe('context window tracking', () => {
    it('exposes lastContextWindow getter/setter', () => {
      expect(pipeline.lastContextWindow).toBeNull();
      pipeline.lastContextWindow = 200000;
      expect(pipeline.lastContextWindow).toBe(200000);
    });
  });
});
