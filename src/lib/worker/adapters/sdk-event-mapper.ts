/**
 * Maps typed SDKMessage objects (from @anthropic-ai/claude-agent-sdk) to AgendoEventPayload arrays.
 *
 * This is the SDK-native counterpart to claude-event-mapper.ts, which parses raw NDJSON strings.
 * The SDK gives us pre-parsed typed objects — this module converts them to the same
 * AgendoEventPayload[] format that the rest of agendo consumes.
 *
 * Mirrors the logic of claude-event-mapper.ts exactly, but replaces all JSON.parse
 * and Record<string, unknown> casts with proper SDK type narrowing.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

export interface SdkEventMapperCallbacks {
  /** Called when a complete assistant message arrives — clear any pending delta buffer. */
  clearDeltaBuffers(): void;
  /** Accumulate a text_delta chunk for batched PG NOTIFY publishing. */
  appendDelta(text: string): void;
  /** Accumulate a thinking_delta chunk. */
  appendThinkingDelta(text: string): void;
  /** Called with cost/turn stats from a `result` event for DB persistence. */
  onResultStats(costUsd: number | null, turns: number | null): void;
  /**
   * Called when a `message_start` stream event fires — provides per-call accurate
   * context stats (NOT aggregated across the turn like `result.modelUsage`).
   */
  onMessageStart?(stats: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }): void;
  /** Called when a session_id is first seen (from system:init). */
  onSessionRef?(sessionRef: string): void;
  /** Called with the UUID of each assistant message (for --resume-session-at). */
  onAssistantUuid?(uuid: string): void;
  /** Called with true when agent starts responding, false when result received. */
  onThinkingChange?(thinking: boolean): void;
}

/**
 * Build the event sequence for a compaction boundary.
 * Mirrors buildCompactEvents() in claude-event-mapper.ts.
 */
function buildCompactEvents(trigger: 'auto' | 'manual', preTokens?: number): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];
  if (trigger === 'auto') {
    events.push({ type: 'system:compact-start', trigger: 'auto' });
  }
  const message =
    preTokens != null
      ? `Conversation compacted (${trigger}, ${preTokens.toLocaleString()} tokens)`
      : 'Conversation history compacted';
  events.push({
    type: 'system:info',
    message,
    ...(preTokens != null ? { compactMeta: { trigger, preTokens } } : {}),
  });
  return events;
}

export function mapSdkMessageToAgendoEvents(
  msg: SDKMessage,
  callbacks: SdkEventMapperCallbacks,
): AgendoEventPayload[] {
  // ── system:init — announces session ID, model, slash commands, MCP servers ──────────────────
  if (msg.type === 'system' && msg.subtype === 'init') {
    callbacks.onSessionRef?.(msg.session_id);
    callbacks.onThinkingChange?.(false);
    return [
      {
        type: 'session:init',
        sessionRef: msg.session_id,
        slashCommands: msg.slash_commands,
        mcpServers: msg.mcp_servers,
        model: msg.model,
        apiKeySource: msg.apiKeySource,
        cwd: msg.cwd,
        tools: msg.tools,
        permissionMode: msg.permissionMode,
      },
    ];
  }

  // ── system:compact_boundary — conversation compaction with metadata ───────────────────────
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    const { trigger, pre_tokens } = msg.compact_metadata;
    return buildCompactEvents(trigger, pre_tokens);
  }

  // ── assistant turn — content blocks: text, tool_use (thinking blocks are skipped) ─────────
  if (msg.type === 'assistant') {
    callbacks.clearDeltaBuffers();
    callbacks.onThinkingChange?.(true);
    callbacks.onAssistantUuid?.(msg.uuid);

    const events: AgendoEventPayload[] = [];

    // Emit system:error if the assistant message itself has an error (auth/billing/rate-limit)
    if (msg.error) {
      events.push({ type: 'system:error', message: `Agent error: ${msg.error}` });
    }

    for (const block of msg.message.content) {
      if (block.type === 'text') {
        events.push({ type: 'agent:text', text: block.text });
      } else if (block.type === 'thinking') {
        // Skip — thinking blocks are emitted via stream_event thinking_delta.
        // Emitting them again here would cause duplicate ThinkingBubbles in the UI.
      } else if (block.type === 'tool_use') {
        events.push(
          buildToolStartEvent(block.id, block.name, block.input as Record<string, unknown>),
        );
      }
    }

    return events;
  }

  // ── user turn — tool_result blocks ────────────────────────────────────────────────────────
  if (msg.type === 'user') {
    const events: AgendoEventPayload[] = [];
    const toolUseResult = msg.tool_use_result as Record<string, unknown> | undefined;
    const content = msg.message.content;

    // content can be a string (plain text) or an array of blocks
    if (Array.isArray(content)) {
      for (const block of content as unknown as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result') {
          events.push({
            ...buildToolEndEvent(
              (block.tool_use_id as string | undefined) ?? '',
              block.content ?? null,
            ),
            durationMs: toolUseResult?.durationMs as number | undefined,
            numFiles: toolUseResult?.numFiles as number | undefined,
            truncated: toolUseResult?.truncated as boolean | undefined,
          });
        }
      }
    }

    return events;
  }

  // ── result — final stats, cost, errors ────────────────────────────────────────────────────
  if (msg.type === 'result') {
    const costUsd = msg.total_cost_usd ?? null;
    const turns = msg.num_turns ?? null;
    const durationMs = msg.duration_ms ?? null;
    const durationApiMs = msg.duration_api_ms ?? null;
    const isError = msg.is_error;
    const subtype = msg.subtype;
    const errors = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors : undefined;

    // Per-model usage breakdown — ModelUsage fields map 1:1 to AgendoEvent's modelUsage shape
    const modelUsage = Object.fromEntries(
      Object.entries(msg.modelUsage).map(([m, u]) => [
        m,
        {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadInputTokens: u.cacheReadInputTokens,
          cacheCreationInputTokens: u.cacheCreationInputTokens,
          costUSD: u.costUSD,
          contextWindow: u.contextWindow,
          maxOutputTokens: u.maxOutputTokens,
        },
      ]),
    );

    // Permission denials — toolInput intentionally omitted (same as claude-event-mapper.ts)
    const permissionDenials = msg.permission_denials.map((d) => ({
      toolName: d.tool_name,
      toolUseId: d.tool_use_id,
    }));

    // Service tier and inference geo — these are CLI extensions not in the typed BetaUsage,
    // so we cast to extract them safely.
    const rawUsage = msg.usage as unknown as Record<string, unknown>;
    const serviceTier =
      typeof rawUsage.service_tier === 'string' ? rawUsage.service_tier : undefined;
    const inferenceGeo =
      typeof rawUsage.inference_geo === 'string' && rawUsage.inference_geo !== ''
        ? rawUsage.inference_geo
        : undefined;

    // Server-side tool usage (web search, fetch)
    const rawServerToolUse = rawUsage.server_tool_use as Record<string, unknown> | undefined;
    const serverToolUse = rawServerToolUse
      ? {
          webSearchRequests: rawServerToolUse.web_search_requests as number | undefined,
          webFetchRequests: rawServerToolUse.web_fetch_requests as number | undefined,
        }
      : undefined;

    callbacks.onResultStats(costUsd, turns);
    callbacks.onThinkingChange?.(false);

    const events: AgendoEventPayload[] = [
      {
        type: 'agent:result',
        costUsd,
        turns,
        durationMs,
        durationApiMs,
        isError,
        subtype,
        errors,
        modelUsage,
        serviceTier,
        inferenceGeo,
        permissionDenials,
        serverToolUse,
      },
    ];

    // Emit system:error so error results appear as red pills in the chat
    if (isError && errors && errors.length > 0) {
      events.push({ type: 'system:error', message: errors.join('; ') });
    }

    return events;
  }

  // ── stream_event — token-level streaming from --include-partial-messages ─────────────────
  if (msg.type === 'stream_event') {
    const event = msg.event;

    // message_start fires once at the beginning of each API call with per-call accurate stats
    if (event.type === 'message_start' && callbacks.onMessageStart) {
      const usage = event.message.usage as unknown as Record<string, unknown>;
      callbacks.onMessageStart({
        inputTokens: (usage.input_tokens as number | undefined) ?? 0,
        cacheReadInputTokens: (usage.cache_read_input_tokens as number | undefined) ?? 0,
        cacheCreationInputTokens: (usage.cache_creation_input_tokens as number | undefined) ?? 0,
      });
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta.type === 'text_delta') {
        callbacks.appendDelta(delta.text);
      } else if (delta.type === 'thinking_delta') {
        callbacks.appendThinkingDelta(delta.thinking);
      }
    }

    // All other stream_event subtypes are ignored — complete messages provide the same data.
    return [];
  }

  // ── rate_limit_event — account rate limit status ──────────────────────────────────────────
  if (msg.type === 'rate_limit_event') {
    const info = msg.rate_limit_info;
    return [
      {
        type: 'system:rate-limit',
        status: info.status,
        rateLimitType: info.rateLimitType ?? 'unknown',
        resetsAt: info.resetsAt ?? 0,
        isUsingOverage: info.isUsingOverage ?? false,
        overageStatus: info.overageStatus,
      },
    ];
  }

  // ── auth_status — authentication progress ─────────────────────────────────────────────────
  if (msg.type === 'auth_status') {
    const lines = msg.output.filter(Boolean);
    if (msg.error) {
      return [{ type: 'system:error', message: `Auth error: ${msg.error}` }];
    }
    if (lines.length > 0) {
      return [{ type: 'system:info', message: lines.join('\n') }];
    }
    return [];
  }

  // All other SDKMessage types (hooks, task progress, tool summaries, etc.) are ignored.
  return [];
}
