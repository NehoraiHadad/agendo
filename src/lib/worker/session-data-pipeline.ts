/**
 * SessionDataPipeline handles NDJSON line buffering, JSON parsing,
 * adapter-specific event mapping, approval-gated tool suppression,
 * interactive tool suppression, and result enrichment.
 *
 * Extracted from session-process.ts to keep that file focused on
 * lifecycle management and control channel handling.
 */

import { createLogger } from '@/lib/logger';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { AgendoEvent, AgendoEventPayload } from '@/lib/realtime/events';
import { ApprovalHandler } from '@/lib/worker/approval-handler';

const log = createLogger('session-data-pipeline');

// ---------------------------------------------------------------------------
// Dependencies interface — injected by SessionProcess
// ---------------------------------------------------------------------------

export interface DataPipelineDeps {
  sessionId: string;
  logWriter: { write(chunk: string, stream: 'stdout' | 'stderr' | 'system' | 'user'): void };
  adapter: {
    mapJsonToEvents?(parsed: Record<string, unknown>): AgendoEventPayload[];
    preProcessLine?(parsed: Record<string, unknown>): void;
    lastAssistantUuid?: string;
  };
  approvalHandler: {
    isSuppressedToolEnd(toolUseId: string, activeToolUseIds: Set<string>): boolean;
    suppressToolStart(toolUseId: string): void;
  };
  activityTracker: {
    clearDeltaBuffers(): void;
    appendDelta(text: string): void;
    appendThinkingDelta(text: string): void;
  };
  activeToolUseIds: Set<string>;
  emitEvent: (payload: AgendoEventPayload) => Promise<AgendoEvent>;
  onEmittedEvent: (event: AgendoEvent) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

/**
 * Enrich an agent:result payload with per-call context stats and the
 * assistant message UUID (used for conversation branching). Pure function.
 */
export function enrichResultPayload(
  partial: AgendoEventPayload,
  perCallContextStats: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  } | null,
  lastAssistantUuid: string | undefined,
): AgendoEventPayload {
  if (partial.type !== 'agent:result') return partial;
  return {
    ...partial,
    ...(perCallContextStats ? { perCallContextStats } : {}),
    ...(lastAssistantUuid ? { messageUuid: lastAssistantUuid } : {}),
  };
}

// ---------------------------------------------------------------------------
// SessionDataPipeline class
// ---------------------------------------------------------------------------

export class SessionDataPipeline {
  private dataBuffer = '';
  private _lastContextWindow: number | null = null;
  private _lastPerCallContextStats: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  } | null = null;

  constructor(private deps: DataPipelineDeps) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get lastContextWindow(): number | null {
    return this._lastContextWindow;
  }

  set lastContextWindow(value: number | null) {
    this._lastContextWindow = value;
  }

  setPerCallContextStats(
    stats: {
      inputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    } | null,
  ): void {
    this._lastPerCallContextStats = stats;
  }

  /**
   * Process a raw data chunk from the agent process stdout.
   * Buffers partial lines, parses complete NDJSON lines, maps to events,
   * applies suppression rules, enriches results, and emits events.
   */
  async processChunk(chunk: string): Promise<void> {
    // Write raw chunk to the session log file under the 'stdout' stream prefix.
    this.deps.logWriter.write(chunk, 'stdout');

    // Buffer partial lines: NDJSON lines from large tool results can span multiple
    // data chunks. Splitting only on '\n' without buffering would emit the tail of
    // a split line as agent:text, showing raw JSON fragments in the UI.
    const combined = this.dataBuffer + chunk;
    const lines = combined.split('\n');
    this.dataBuffer = lines.pop() ?? ''; // last element is incomplete (no trailing \n yet)

    // Parse each NDJSON line and map to a structured AgendoEvent.
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) {
        await this.deps.emitEvent({ type: 'agent:text', text: trimmed });
        continue;
      }

      // Separate try-catch for JSON parsing vs event emission so that a
      // transient emit failure (DB error, etc.) never causes raw JSON to leak
      // into the chat as a system:info message.
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Line is not JSON — treat as plain text info (shell output, etc.)
        await this.deps.emitEvent({ type: 'system:info', message: trimmed });
        continue;
      }

      try {
        // Delegate adapter-specific pre-processing (Claude: interactive tool failure
        // detection + assistant UUID capture). No-op for Codex/Gemini.
        this.deps.adapter.preProcessLine?.(parsed);

        if (!this.deps.adapter.mapJsonToEvents) {
          log.warn(
            { sessionId: this.deps.sessionId, line: trimmed.slice(0, 200) },
            'Adapter has no mapJsonToEvents — skipping NDJSON line',
          );
          continue;
        }
        let partials: AgendoEventPayload[];
        try {
          partials = this.deps.adapter.mapJsonToEvents(parsed);
        } catch (mapErr) {
          log.warn(
            { err: mapErr, sessionId: this.deps.sessionId, line: trimmed.slice(0, 200) },
            'mapJsonToEvents error',
          );
          continue;
        }

        for (const partial of partials) {
          // Suppress tool-start/tool-end for approval-gated tools (ExitPlanMode, …).
          // These appear only as control_request approval cards — not as ToolCard widgets.
          if (
            partial.type === 'agent:tool-start' &&
            ApprovalHandler.APPROVAL_GATED_TOOLS.has(partial.toolName)
          ) {
            this.deps.activeToolUseIds.add(partial.toolUseId); // keep for cleanup
            this.deps.approvalHandler.suppressToolStart(partial.toolUseId);
            continue;
          }
          if (
            partial.type === 'agent:tool-end' &&
            this.deps.approvalHandler.isSuppressedToolEnd(
              partial.toolUseId,
              this.deps.activeToolUseIds,
            )
          ) {
            continue;
          }

          // Suppress the error tool-end for any interactive tool: the UI card
          // stays live and pushToolResult routes the human's answer when it arrives.
          const enrichedPartial = enrichResultPayload(
            partial,
            this._lastPerCallContextStats,
            this.deps.adapter.lastAssistantUuid,
          );
          const event = await this.deps.emitEvent(enrichedPartial);
          await this.deps.onEmittedEvent(event);
        }
      } catch (err) {
        // Event emission failed (transient DB/publish error). Log but don't
        // surface raw JSON to the user — it would appear as a broken UI element.
        log.error({ err, sessionId: this.deps.sessionId }, 'Failed to emit event');
      }
    }
  }

  /**
   * Persist fire-and-forget DB side-effects triggered by emitted events.
   * Currently handles:
   *   - session:init → persist sessionRef + model
   *   - agent:result with serverToolUse → persist webSearchRequests/webFetchRequests
   */
  async persistEventSideEffects(event: AgendoEvent): Promise<void> {
    if (event.type === 'session:init') {
      const updates: Record<string, string> = {};
      if (event.sessionRef) {
        updates.sessionRef = event.sessionRef;
      }
      if (event.model) {
        updates.model = event.model;
      }
      if (Object.keys(updates).length > 0) {
        await db.update(sessions).set(updates).where(eq(sessions.id, this.deps.sessionId));
      }
    }

    if (event.type === 'agent:result' && event.serverToolUse) {
      const { webSearchRequests, webFetchRequests } = event.serverToolUse;
      void db
        .update(sessions)
        .set({
          ...(webSearchRequests != null && { webSearchRequests }),
          ...(webFetchRequests != null && { webFetchRequests }),
        })
        .where(eq(sessions.id, this.deps.sessionId))
        .catch((err: unknown) => {
          log.error({ err, sessionId: this.deps.sessionId }, 'web tool usage update failed');
        });
    }
  }

  /**
   * Flush the data buffer and return any accumulated partial text.
   * Clears the buffer. Used by transitionTo('awaiting_input') to emit
   * trailing text that lacked a final newline.
   */
  flushBuffer(): string {
    const text = this.dataBuffer;
    this.dataBuffer = '';
    return text;
  }
}
