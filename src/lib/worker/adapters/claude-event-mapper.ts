/**
 * Maps parsed Claude stream-json NDJSON objects to AgendoEventPayload arrays.
 *
 * Extracted from SessionProcess to keep session-process.ts focused on lifecycle
 * and event routing. This module has no class state — it is a pure(ish) function
 * that accepts side-effect callbacks for delta buffering.
 *
 * Claude's --output-format stream-json emits NDJSON where tool_use and
 * tool_result blocks are nested inside message.content arrays, NOT as
 * top-level types. Each call may return multiple events (e.g. one assistant
 * message containing both a text block and a tool_use block).
 */

import type { AgendoEventPayload } from '@/lib/realtime/events';

export interface ClaudeEventMapperCallbacks {
  /** Called when a complete assistant message arrives — clear any pending delta buffer. */
  clearDeltaBuffers(): void;
  /** Accumulate a text_delta chunk for batched PG NOTIFY publishing. */
  appendDelta(text: string): void;
  /** Accumulate a thinking_delta chunk. */
  appendThinkingDelta(text: string): void;
  /** Called with cost/turn stats from a `result` event for DB persistence. */
  onResultStats(costUsd: number | null, turns: number | null): void;
}

export function mapClaudeJsonToEvents(
  parsed: Record<string, unknown>,
  callbacks: ClaudeEventMapperCallbacks,
): AgendoEventPayload[] {
  const type = parsed.type as string | undefined;

  // Claude CLI system/init — announces the session ID and available slash commands
  if (type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
    const slashCommands = Array.isArray(parsed.slash_commands)
      ? (parsed.slash_commands as string[])
      : [];
    const mcpServers = Array.isArray(parsed.mcp_servers)
      ? (parsed.mcp_servers as Array<{ name: string; status?: string; tools?: string[] }>)
      : [];
    const model = typeof parsed.model === 'string' ? parsed.model : undefined;
    const apiKeySource = typeof parsed.apiKeySource === 'string' ? parsed.apiKeySource : undefined;
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined;
    const tools = Array.isArray(parsed.tools) ? (parsed.tools as string[]) : undefined;
    const permissionMode =
      typeof parsed.permissionMode === 'string' ? parsed.permissionMode : undefined;
    return [
      {
        type: 'session:init',
        sessionRef: parsed.session_id as string,
        slashCommands,
        mcpServers,
        model,
        apiKeySource,
        cwd,
        tools,
        permissionMode,
      },
    ];
  }

  // Assistant turn: content is an array of blocks (text, tool_use, thinking, etc.)
  // Clear any pending delta buffer — the complete text is the source of truth.
  if (type === 'assistant') {
    callbacks.clearDeltaBuffers();
    const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
    const events: AgendoEventPayload[] = [];
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        events.push({ type: 'agent:text', text: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        events.push({ type: 'agent:thinking', text: block.thinking });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'agent:tool-start',
          toolUseId: (block.id as string | undefined) ?? '',
          toolName: (block.name as string | undefined) ?? '',
          input: (block.input as Record<string, unknown> | undefined) ?? {},
        });
      }
    }
    return events;
  }

  // User turn: content is an array of blocks (tool_result, etc.)
  if (type === 'user') {
    const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
    const toolUseResult = parsed.tool_use_result as Record<string, unknown> | undefined;
    const events: AgendoEventPayload[] = [];
    for (const block of message?.content ?? []) {
      if (block.type === 'tool_result') {
        events.push({
          type: 'agent:tool-end',
          toolUseId: (block.tool_use_id as string | undefined) ?? '',
          content: block.content ?? null,
          durationMs: toolUseResult?.durationMs as number | undefined,
          numFiles: toolUseResult?.numFiles as number | undefined,
          truncated: toolUseResult?.truncated as boolean | undefined,
        });
      }
    }
    return events;
  }

  // Agent thinking output (top-level, extended thinking mode)
  if (type === 'thinking') {
    return [{ type: 'agent:thinking', text: (parsed.thinking as string | undefined) ?? '' }];
  }

  // Final result with cost/duration stats
  if (type === 'result') {
    const costUsd = (parsed.total_cost_usd as number | null | undefined) ?? null;
    const turns = (parsed.num_turns as number | null | undefined) ?? null;
    const durationMs = (parsed.duration_ms as number | null | undefined) ?? null;
    const durationApiMs = (parsed.duration_api_ms as number | null | undefined) ?? null;
    const isError = parsed.is_error === true;
    const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : undefined;
    const rawErrors = Array.isArray(parsed.errors)
      ? (parsed.errors as string[]).filter((e) => typeof e === 'string')
      : undefined;
    const errors = rawErrors && rawErrors.length > 0 ? rawErrors : undefined;

    // Per-model usage breakdown
    const rawModelUsage = parsed.modelUsage as Record<string, Record<string, unknown>> | undefined;
    const modelUsage = rawModelUsage
      ? Object.fromEntries(
          Object.entries(rawModelUsage).map(([m, u]) => [
            m,
            {
              inputTokens: (u.inputTokens as number) ?? 0,
              outputTokens: (u.outputTokens as number) ?? 0,
              cacheReadInputTokens: u.cacheReadInputTokens as number | undefined,
              cacheCreationInputTokens: u.cacheCreationInputTokens as number | undefined,
              costUSD: (u.costUSD as number) ?? 0,
              contextWindow: u.contextWindow as number | undefined,
              maxOutputTokens: u.maxOutputTokens as number | undefined,
            },
          ]),
        )
      : undefined;

    // Permission denials
    const rawDenials = Array.isArray(parsed.permission_denials)
      ? (parsed.permission_denials as Array<Record<string, unknown>>)
      : undefined;
    const permissionDenials = rawDenials?.map((d) => ({
      toolName: (d.tool_name as string) ?? '',
      toolUseId: (d.tool_use_id as string) ?? '',
      toolInput: d.tool_input as Record<string, unknown> | undefined,
    }));

    // Service tier and inference geo
    const rawUsage = parsed.usage as Record<string, unknown> | undefined;
    const serviceTier =
      typeof rawUsage?.service_tier === 'string' ? rawUsage.service_tier : undefined;
    const inferenceGeo =
      typeof rawUsage?.inference_geo === 'string' && rawUsage.inference_geo !== ''
        ? rawUsage.inference_geo
        : undefined;

    // Server-side tool usage (web search, fetch)
    const rawServerToolUse = rawUsage?.server_tool_use as Record<string, unknown> | undefined;
    const serverToolUse = rawServerToolUse
      ? {
          webSearchRequests: rawServerToolUse.web_search_requests as number | undefined,
          webFetchRequests: rawServerToolUse.web_fetch_requests as number | undefined,
        }
      : undefined;

    // Notify session-process to persist cost/turn stats to DB (fire-and-forget).
    callbacks.onResultStats(costUsd, turns);

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

    // Emit a system:error so error results appear as red pills in the chat
    if (isError && errors && errors.length > 0) {
      events.push({ type: 'system:error', message: errors.join('; ') });
    }

    return events;
  }

  // compact_boundary — conversation compaction with metadata (new protocol)
  if (type === 'system' && parsed.subtype === 'compact_boundary') {
    const compactMeta = parsed.compact_metadata as
      | { trigger?: string; pre_tokens?: number }
      | undefined;
    const trigger = compactMeta?.trigger === 'manual' ? ('manual' as const) : ('auto' as const);
    const preTokens = typeof compactMeta?.pre_tokens === 'number' ? compactMeta.pre_tokens : 0;
    return [
      {
        type: 'system:info',
        message: `Conversation compacted (${trigger}, ${preTokens.toLocaleString()} tokens)`,
        compactMeta: { trigger, preTokens },
      },
    ];
  }

  // Claude emits a 'compact' message when it compacts the conversation history (legacy).
  if (type === 'compact') {
    return [{ type: 'system:info', message: 'Conversation history compacted' }];
  }

  // rate_limit_event — account rate limit status from Claude Code
  if (type === 'rate_limit_event') {
    const info = parsed.rate_limit_info as Record<string, unknown> | undefined;
    if (info) {
      return [
        {
          type: 'system:rate-limit',
          status: (info.status as string) ?? 'unknown',
          rateLimitType: (info.rateLimitType as string) ?? 'unknown',
          resetsAt: (info.resetsAt as number) ?? 0,
          isUsingOverage: (info.isUsingOverage as boolean) ?? false,
          overageStatus: info.overageStatus as string | undefined,
        },
      ];
    }
    return [];
  }

  // stream_event — token-level streaming from --include-partial-messages.
  // Batch text_delta and thinking_delta events to limit PG NOTIFY throughput (~5 events/sec).
  if (type === 'stream_event') {
    const event = parsed.event as Record<string, unknown> | undefined;
    if (event?.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        callbacks.appendDelta(delta.text);
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        callbacks.appendThinkingDelta(delta.thinking);
      }
    }
    // All other stream_event subtypes (message_start, content_block_start/stop,
    // message_delta, message_stop) are ignored — the complete messages provide
    // the same data in a more reliable form.
    return [];
  }

  return [];
}
