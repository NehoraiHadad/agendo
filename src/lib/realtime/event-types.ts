// ============================================================================
// AgendoEvent — emitted by the worker, consumed by the frontend via SSE
// ============================================================================

/** Base fields present on every event */
interface EventBase {
  /** Monotonic sequence number within a session (used as SSE last-event-id) */
  id: number;
  /** UUID of the session this event belongs to */
  sessionId: string;
  /** Unix timestamp ms */
  ts: number;
}

export type AgendoEvent =
  | (EventBase & { type: 'agent:text'; text: string })
  | (EventBase & { type: 'agent:text-delta'; text: string; fromDelta?: boolean })
  | (EventBase & { type: 'agent:thinking'; text: string })
  | (EventBase & { type: 'agent:thinking-delta'; text: string })
  | (EventBase & {
      type: 'agent:tool-start';
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
    })
  | (EventBase & {
      type: 'agent:tool-end';
      toolUseId: string;
      content: unknown;
      durationMs?: number;
      numFiles?: number;
      truncated?: boolean;
    })
  | (EventBase & {
      type: 'agent:result';
      costUsd: number | null;
      turns: number | null;
      durationMs: number | null;
      isError?: boolean;
      subtype?: string;
      errors?: string[];
      durationApiMs?: number | null;
      modelUsage?: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD: number;
          contextWindow?: number;
          maxOutputTokens?: number;
        }
      >;
      serviceTier?: string;
      inferenceGeo?: string;
      permissionDenials?: Array<{
        toolName: string;
        toolUseId: string;
      }>;
      serverToolUse?: { webSearchRequests?: number; webFetchRequests?: number };
      /**
       * Per-call context stats captured from the last `message_start` stream event before
       * this result. Unlike `modelUsage` (which aggregates across all API calls in the turn),
       * these values represent a single API call and give an accurate context window reading.
       * Formula: inputTokens + cacheReadInputTokens + cacheCreationInputTokens = actual context used.
       */
      perCallContextStats?: {
        inputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
      };
      /**
       * Claude JSONL UUID of this assistant turn — passed as --resume-session-at when branching.
       * Only present for Claude sessions. Undefined for Codex/Gemini.
       */
      messageUuid?: string;
    })
  | (EventBase & { type: 'agent:activity'; thinking: boolean })
  | (EventBase & {
      type: 'agent:tool-approval';
      approvalId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      dangerLevel: number;
    })
  | (EventBase & {
      type: 'session:init';
      sessionRef: string;
      slashCommands: string[];
      mcpServers: Array<{ name: string; status?: string; tools?: string[] }>;
      model?: string;
      apiKeySource?: string;
      cwd?: string;
      tools?: string[];
      permissionMode?: string;
    })
  | (EventBase & {
      type: 'session:commands';
      slashCommands: Array<{ name: string; description: string; argumentHint: string }>;
    })
  | (EventBase & { type: 'session:state'; status: SessionStatus })
  | (EventBase & { type: 'session:mode-change'; mode: string })
  | (EventBase & {
      type: 'agent:plan';
      entries: Array<{
        content: string;
        priority: 'high' | 'medium' | 'low';
        status: 'pending' | 'in_progress' | 'completed';
      }>;
    })
  | (EventBase & { type: 'agent:usage'; used: number; size: number; costUsd?: number })
  | (EventBase & { type: 'session:info'; title?: string | null })
  | (EventBase & { type: 'user:message'; text: string; hasImage?: boolean })
  | (EventBase & {
      type: 'system:info';
      message: string;
      compactMeta?: { trigger: 'auto' | 'manual'; preTokens: number };
    })
  | (EventBase & { type: 'system:compact-start'; trigger: 'auto' | 'manual' })
  | (EventBase & { type: 'system:error'; message: string })
  | (EventBase & {
      type: 'system:mcp-status';
      servers: Array<{ name: string; status: string }>;
    })
  | (EventBase & {
      type: 'system:rate-limit';
      status: string;
      rateLimitType: string;
      resetsAt: number;
      isUsingOverage: boolean;
      overageStatus?: string;
    })
  | (EventBase & {
      type: 'agent:ask-user';
      requestId: string;
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string; markdown?: string }>;
        multiSelect: boolean;
      }>;
    })
  | (EventBase & {
      type: 'team:message';
      /** Slug of the team agent that sent this message (e.g. "mobile-analyst") */
      fromAgent: string;
      /** Raw message text — plain markdown or JSON-encoded structured payload */
      text: string;
      summary?: string;
      /** Agent color hint from the Claude team config (e.g. "blue", "green") */
      color?: string;
      /** Original timestamp from the team inbox file */
      sourceTimestamp: string;
      /** True when text is valid JSON (idle_notification, task_assignment, etc.) */
      isStructured: boolean;
      structuredPayload?: Record<string, unknown>;
    })
  /** Emitted when team is first detected (on attach) and re-emitted when new members join */
  | (EventBase & {
      type: 'team:config';
      teamName: string;
      members: Array<{
        name: string;
        agentId: string;
        agentType: string;
        model: string;
        color?: string;
        planModeRequired?: boolean;
        joinedAt: number;
        tmuxPaneId: string;
        backendType?: string;
      }>;
    })
  /** Emitted as a snapshot of the current task list (all tasks, not just diffs) */
  | (EventBase & {
      type: 'team:task-update';
      tasks: Array<{
        id: string;
        subject: string;
        status: 'pending' | 'in_progress' | 'completed';
        owner?: string;
        blocks: string[];
        blockedBy: string[];
      }>;
    })
  /** Lead → teammate messages (monitoring ALL inboxes, not just team-lead) */
  | (EventBase & {
      type: 'team:outbox-message';
      toAgent: string;
      fromAgent: string;
      text: string;
      summary?: string;
      color?: string;
      sourceTimestamp: string;
      isStructured: boolean;
      structuredPayload?: Record<string, unknown>;
    })
  /** Agent tool spawns a subagent within this session */
  | (EventBase & {
      type: 'subagent:start';
      agentId: string;
      toolUseId: string;
      subagentType?: string;
      description?: string;
    })
  /** Subagent transcript progress (from JSONL file tailing) */
  | (EventBase & {
      type: 'subagent:progress';
      agentId: string;
      eventType: 'tool_use' | 'text' | 'result';
      toolName?: string;
      summary?: string;
    })
  /** AI-written summary of subagent progress (from agentProgressSummaries SDK feature, Claude only) */
  | (EventBase & {
      type: 'agent:subagent-progress';
      taskId: string;
      description: string;
      summary?: string;
      usage?: { totalTokens: number; toolUses: number; durationMs: number };
    })
  /** Predicted next user prompt emitted after each turn (from promptSuggestions SDK feature, Claude only) */
  | (EventBase & {
      type: 'session:suggestion';
      suggestion: string;
    })
  /** Subagent completed (tool-end event or transcript file end) */
  | (EventBase & {
      type: 'subagent:complete';
      agentId: string;
      toolUseId: string;
      success: boolean;
    });

export type SessionStatus = 'active' | 'awaiting_input' | 'idle' | 'ended';

// ============================================================================
// BrainstormEvent — emitted by the orchestrator, consumed by the frontend via SSE
// ============================================================================

/** Base fields present on every brainstorm event */
interface BrainstormEventBase {
  /** Monotonic sequence number within a room */
  id: number;
  /** UUID of the brainstorm room */
  roomId: string;
  /** Unix timestamp ms */
  ts: number;
}

export type BrainstormEvent =
  | (BrainstormEventBase & { type: 'room:state'; status: BrainstormRoomStatus })
  | (BrainstormEventBase & { type: 'wave:start'; wave: number })
  | (BrainstormEventBase & { type: 'wave:complete'; wave: number })
  | (BrainstormEventBase & {
      type: 'participant:status';
      agentId: string;
      agentName: string;
      status: 'thinking' | 'done' | 'passed' | 'timeout' | 'evicted';
    })
  | (BrainstormEventBase & {
      type: 'message';
      wave: number;
      senderType: 'agent' | 'user';
      agentId?: string;
      agentName?: string;
      content: string;
      isPass: boolean;
    })
  | (BrainstormEventBase & {
      type: 'message:delta';
      agentId: string;
      text: string;
    })
  | (BrainstormEventBase & { type: 'room:converged'; wave: number })
  | (BrainstormEventBase & { type: 'room:soft-converged'; wave: number })
  | (BrainstormEventBase & { type: 'room:stalled'; wave: number })
  | (BrainstormEventBase & { type: 'room:max-waves'; wave: number })
  | (BrainstormEventBase & { type: 'room:synthesis'; synthesis: string })
  | (BrainstormEventBase & {
      type: 'participant:activity';
      agentId: string;
      /** Human-readable description of what the agent is doing, e.g. "Reading orchestrator.ts" */
      description: string;
    })
  | (BrainstormEventBase & {
      type: 'participant:joined';
      agentId: string;
      agentName: string;
    })
  | (BrainstormEventBase & {
      type: 'participant:left';
      agentId: string;
      agentName: string;
    })
  | (BrainstormEventBase & { type: 'room:error'; message: string })
  | (BrainstormEventBase & { type: 'wave:review'; wave: number; timeoutSec: number })
  | (BrainstormEventBase & {
      type: 'wave:quality';
      wave: number;
      score: {
        wave: number;
        newIdeasCount: number;
        avgResponseLength: number;
        repeatRatio: number;
        passCount: number;
        agreementRatio: number;
      };
    })
  | (BrainstormEventBase & { type: 'wave:reflection'; wave: number });

export type BrainstormRoomStatus = 'waiting' | 'active' | 'paused' | 'synthesizing' | 'ended';

/** Payload without base fields (for constructing events in the orchestrator) */
export type BrainstormEventPayload = BrainstormEvent extends infer E
  ? E extends BrainstormEvent
    ? Omit<E, 'id' | 'roomId' | 'ts'>
    : never
  : never;

// ============================================================================
// AgendoControl — sent by the frontend to the worker via PG NOTIFY
// ============================================================================

/** Priority for messages pushed to the Claude SDK's internal queue. */
export type MessagePriority = 'now' | 'next' | 'later';

export type AgendoControl =
  | {
      type: 'message';
      text: string;
      imageRef?: { path: string; mimeType: string };
      priority?: MessagePriority;
    }
  | { type: 'cancel' }
  | { type: 'interrupt' }
  | { type: 'redirect'; newPrompt: string }
  | {
      type: 'tool-approval';
      approvalId: string;
      toolName: string;
      decision: 'allow' | 'deny' | 'allow-session';
      /** Modified tool input to send back to Claude (only for 'allow' decisions with edits). */
      updatedInput?: Record<string, unknown>;
      /** ExitPlanMode: switch permission mode AFTER allowing the tool. */
      postApprovalMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
      /** ExitPlanMode: compact conversation after allowing the tool. */
      postApprovalCompact?: boolean;
      /** ExitPlanMode option 1: deny tool, kill process, restart fresh with plan as context. */
      clearContextRestart?: boolean;
      /** Internal: new child session ID pre-created by the API route for active-session restarts.
       *  The worker reads this in session-process.ts and enqueues it from onExit. */
      newSessionIdForWorker?: string;
      /** Codex only: remember this command approval as a session-scoped exec policy rule. */
      rememberForSession?: boolean;
    }
  | {
      /** Send a tool_result back to Claude for a pending tool_use (e.g. AskUserQuestion). */
      type: 'tool-result';
      toolUseId: string;
      content: string;
    }
  | {
      /** Change the permission mode of a live session. Worker restarts the process with the new mode. */
      type: 'set-permission-mode';
      mode: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';
    }
  | {
      /** Switch the AI model of a live session via control_request. */
      type: 'set-model';
      model: string;
    }
  | {
      /** Inject a steering message into the current Codex turn (mid-turn). */
      type: 'steer';
      message: string;
    }
  | {
      /** Rollback the last N turns in a Codex thread (conversation-only, files unchanged). */
      type: 'rollback';
      numTurns?: number;
    }
  | {
      /** Replace all MCP servers on a live session (Claude SDK only). */
      type: 'mcp-set-servers';
      servers: Record<string, unknown>;
    }
  | {
      /** Reconnect a specific MCP server by name (Claude SDK only). */
      type: 'mcp-reconnect';
      serverName: string;
    }
  | {
      /** Enable/disable a specific MCP server by name (Claude SDK only). */
      type: 'mcp-toggle';
      serverName: string;
      enabled: boolean;
    }
  | {
      /** Rewind files to the state at a given user message (requires file checkpointing, Claude SDK only). */
      type: 'rewind-files';
      userMessageId: string;
      dryRun?: boolean;
    };

// ============================================================================
// Distributive Omit for AgendoEvent
// ============================================================================

/**
 * Distributive Omit that preserves discriminated union members.
 * Use this instead of plain `Omit<AgendoEvent, Keys>` to avoid collapsing the union.
 */
export type AgendoEventPayload = AgendoEvent extends infer E
  ? E extends AgendoEvent
    ? Omit<E, 'id' | 'sessionId' | 'ts'>
    : never
  : never;
