import type { AttachmentRef } from '@/lib/attachments';

export type PermissionMode = 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';

export type PermissionDecision =
  | 'allow'
  | 'deny'
  | 'allow-session'
  | {
      behavior: 'allow';
      /** Modified tool input to send back to the agent. */
      updatedInput?: Record<string, unknown>;
      /** Codex only: remember approval rule for this command pattern in the session. */
      rememberForSession?: boolean;
    };

/** Full context of a tool approval request, passed to the ApprovalHandler. */
export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** MCP server descriptor for the ACP session/new protocol (used by Gemini).
 *  Note: env is an array of {name, value} pairs, NOT a Record — this matches
 *  Gemini CLI's envVariableSchema in its zod schema. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface SpawnOpts {
  cwd: string;
  env: Record<string, string>;
  executionId: string;
  timeoutSec: number;
  maxOutputBytes: number;
  extraArgs?: string[];
  /** Controls per-tool-call gating within a running session. Default: 'default' (ask). */
  permissionMode?: PermissionMode;
  /** Tool name patterns already approved for this session (from session.allowedTools). */
  allowedTools?: string[];
  /** MCP servers to inject via ACP session/new (Gemini only). */
  mcpServers?: AcpMcpServer[];
  /** TOML policy files to inject via --policy (Gemini only). */
  policyFiles?: string[];
  /** Initial attachments to attach to the first user message on spawn/resume. */
  initialAttachments?: AttachmentRef[];
  /** Max budget in USD for this session. Claude will stop when exceeded. */
  maxBudgetUsd?: number;
  /** Effort level for this session: controls depth of thinking and resource usage. */
  effort?: 'low' | 'medium' | 'high';
  /** When true, Claude won't write a session JSONL file to ~/.claude/projects/.
   *  Useful for one-shot execution sessions that will never be resumed. */
  noSessionPersistence?: boolean;
  /** Fallback model when primary model is overloaded. */
  fallbackModel?: string;
  /** Override the default AI model (forwarded as --model / -m to the CLI). */
  model?: string;
  /** When true, only use MCP servers from the provided config (ignore global). */
  strictMcpConfig?: boolean;
  /** Force a specific session UUID (syncs with agendo's session ID). */
  sessionId?: string;
  /** Text to append to Claude's system prompt (e.g., MCP context preamble). */
  appendSystemPrompt?: string;
  /** SDK-format MCP server configs for Claude SDK adapter (replaces mcpConfigPath/--mcp-config). */
  sdkMcpServers?: Record<
    string,
    {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
  /** When true, enable file checkpointing so files can be rewound to previous states (Claude SDK only). */
  enableFileCheckpointing?: boolean;
  /** Structured output format — agent returns JSON validated against the given schema (Claude SDK only). */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown>; name?: string };
  /** When true, pass --worktree to create an isolated git worktree (Claude only). */
  useWorktree?: boolean;
  /** When true, adds --fork-session to --resume so Claude creates a new session ID
   *  initialized from the resumed session's conversation history (Claude only). */
  forkSession?: boolean;
  /** Claude JSONL UUID to pass as --resume-session-at. Truncates conversation
   *  history at that assistant message when combined with --fork-session. */
  resumeSessionAt?: string;
  /** System-level instructions injected before the user's initial message.
   *  For Codex app-server: passed as `developerInstructions` in thread/start. */
  developerInstructions?: string;
  /** SDK hook callbacks keyed by HookEvent name (e.g. PreToolUse, PostToolUse).
   *  Each value is an array of HookCallbackMatcher objects. Claude SDK only. */
  sdkHooks?: Partial<
    Record<
      string,
      Array<{
        matcher?: string;
        hooks: Array<
          (
            input: Record<string, unknown>,
            toolUseID: string | undefined,
            options: { signal: AbortSignal },
          ) => Promise<Record<string, unknown>>
        >;
        timeout?: number;
      }>
    >
  >;
  /** Programmatically defined subagents keyed by agent name.
   *  Each value is an AgentDefinition. Claude SDK only. */
  sdkAgents?: Record<
    string,
    {
      description: string;
      prompt: string;
      tools?: string[];
      disallowedTools?: string[];
      model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
      skills?: string[];
      maxTurns?: number;
    }
  >;
  /** When set, uses the named agent definition (from sdkAgents or settings) as
   *  the main thread agent. Claude SDK only. */
  sdkAgent?: string;
}

export interface ManagedProcess {
  /** Real OS PID, or null for in-process adapters (e.g. ClaudeSdkAdapter) that have no child process. */
  pid: number | null;
  tmuxSession?: string; // Optional: SDK adapter doesn't use tmux
  stdin?: NodeJS.WritableStream | null; // Optional: SDK adapter doesn't expose raw stdin
  kill: (signal: NodeJS.Signals) => void;
  onData: (cb: (chunk: string) => void) => void;
  onExit: (cb: (code: number | null) => void) => void;
  /**
   * Optional direct-event path for SDK adapters that produce typed AgendoEventPayloads
   * without going through the NDJSON string pipe. When present, SessionProcess wires
   * this to SessionDataPipeline.processEvents() instead of the normal processChunk path.
   */
  onEvents?: (cb: (payloads: import('@/lib/realtime/events').AgendoEventPayload[]) => void) => void;
}

/** Callback type injected by SessionProcess to handle per-tool approval requests. */
export type ToolApprovalFn = (request: ApprovalRequest) => Promise<PermissionDecision>;

/** Callbacks injected by SessionProcess for SDK adapters that handle stream_event
 *  delta buffering internally (instead of relying on SessionDataPipeline's NDJSON path). */
export interface ActivityCallbacks {
  clearDeltaBuffers(): void;
  appendDelta(text: string): void;
  appendThinkingDelta(text: string): void;
  onMessageStart?(stats: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }): void;
  onResultStats?(costUsd: number | null, turns: number | null): void;
}

// ---------------------------------------------------------------------------
// Core AgentAdapter — required methods every adapter must implement
// ---------------------------------------------------------------------------

export interface AgentAdapter {
  spawn(prompt: string, opts: SpawnOpts): ManagedProcess;
  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess;
  extractSessionId(output: string): string | null;
  sendMessage(
    message: string,
    attachments?: AttachmentRef[],
    priority?: import('@/lib/realtime/events').MessagePriority,
    clientId?: string,
  ): Promise<void>;
  interrupt(): Promise<void>;
  isAlive(): boolean;
  onThinkingChange(cb: (thinking: boolean) => void): void;
  setApprovalHandler(handler: ToolApprovalFn): void;
}

// ---------------------------------------------------------------------------
// Capability interfaces — optional features declared by concrete adapters
// ---------------------------------------------------------------------------

/** Adapter can notify callers when the CLI-native session reference is available. */
export interface SupportsSessionRef {
  onSessionRef(cb: (ref: string) => void): void;
}

/** Adapter supports in-place model switching (no process restart). */
export interface SupportsModelSwitch {
  setModel(model: string): Promise<boolean>;
}

/** Adapter supports in-place permission mode switching (no process restart). */
export interface SupportsPermissionModeSwitch {
  setPermissionMode(mode: string): Promise<boolean>;
}

/** Adapter supports querying and managing MCP server connections. */
export interface SupportsMcpManagement {
  getMcpStatus(): Promise<Record<string, unknown> | null>;
  /** Replace all MCP servers on a live session (Claude SDK only). */
  setMcpServers?(servers: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** Reconnect a specific MCP server by name (Claude SDK only). */
  reconnectMcpServer?(serverName: string): Promise<void>;
  /** Enable/disable a specific MCP server by name (Claude SDK only). */
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<void>;
}

/**
 * Adapter can retrieve conversation history from the CLI's native storage.
 *
 * - Claude: reads JSONL on disk (works offline), falls back to SDK getSessionMessages()
 * - Codex: calls thread/read via JSON-RPC (requires a running app-server process)
 * - ACP (Gemini/Copilot/OpenCode): in-memory; falls back to Agendo log file after restart
 *
 * @param sessionRef - CLI-native session/thread ID (Claude UUID or Codex threadId)
 * @param cwd - Working directory hint (helps Claude find the right project JSONL)
 * @param logFilePath - Path to the Agendo session log file (used as fallback by ACP adapters)
 */
export interface SupportsHistory {
  getHistory(
    sessionRef: string,
    cwd?: string,
    logFilePath?: string,
  ): Promise<import('@/lib/realtime/events').AgendoEventPayload[] | null>;
}

/**
 * Adapter maps a parsed JSON line from the agent's STDIO output to AgendoEventPayloads.
 * Used by SessionDataPipeline for adapter-specific NDJSON event parsing.
 */
export interface SupportsEventMapping {
  mapJsonToEvents(
    parsed: Record<string, unknown>,
  ): import('@/lib/realtime/events').AgendoEventPayload[];
  /** The last captured assistant message UUID, used for conversation branching (Claude only). */
  lastAssistantUuid?: string;
}

/**
 * Adapter accepts activity callbacks for SDK adapters that handle stream_event
 * delta buffering internally (instead of the NDJSON pipeline).
 * Called by SessionProcess before start().
 */
export interface SupportsActivityCallbacks {
  setActivityCallbacks(callbacks: ActivityCallbacks): void;
}

/** Adapter supports sending tool_result NDJSON messages for pending tool_use calls (e.g. AskUserQuestion). */
export interface SupportsToolResult {
  sendToolResult(toolUseId: string, content: string): Promise<void>;
}

/** Adapter supports removing a queued message before the SDK consumes it. */
export interface SupportsCancelQueuedMessage {
  /** Returns true if the message was removed, false if it was already consumed. */
  cancelQueuedMessage(clientId: string): boolean;
}

/** Adapter supports injecting a steering message into the current running turn (Codex only). */
export interface SupportsSteer {
  steer(message: string): Promise<void>;
}

/** Adapter supports rolling back the last N turns in the agent thread (Codex only). */
export interface SupportsRollback {
  rollback(numTurns?: number): Promise<void>;
}

/**
 * Adapter supports rewinding files to a previous state at a given user message.
 * Requires enableFileCheckpointing in SpawnOpts (Claude SDK only).
 */
export interface SupportsFileCheckpointing {
  rewindFiles(userMessageId: string, dryRun?: boolean): Promise<Record<string, unknown> | null>;
}

// ---------------------------------------------------------------------------
// Type guard functions — compile-time safe capability checks
// ---------------------------------------------------------------------------

/** Type guard: adapter can notify callers when a CLI session reference is available. */
export function supportsSessionRef(a: AgentAdapter): a is AgentAdapter & SupportsSessionRef {
  return 'onSessionRef' in a && typeof (a as SupportsSessionRef).onSessionRef === 'function';
}

/** Type guard: adapter supports in-place model switching. */
export function supportsModelSwitch(a: AgentAdapter): a is AgentAdapter & SupportsModelSwitch {
  return 'setModel' in a && typeof (a as SupportsModelSwitch).setModel === 'function';
}

/** Type guard: adapter supports in-place permission mode switching. */
export function supportsPermissionModeSwitch(
  a: AgentAdapter,
): a is AgentAdapter & SupportsPermissionModeSwitch {
  return (
    'setPermissionMode' in a &&
    typeof (a as SupportsPermissionModeSwitch).setPermissionMode === 'function'
  );
}

/** Type guard: adapter supports querying and managing MCP server connections. */
export function supportsMcpManagement(a: AgentAdapter): a is AgentAdapter & SupportsMcpManagement {
  return 'getMcpStatus' in a && typeof (a as SupportsMcpManagement).getMcpStatus === 'function';
}

/** Type guard: adapter can retrieve conversation history from CLI-native storage. */
export function supportsHistory(a: AgentAdapter): a is AgentAdapter & SupportsHistory {
  return 'getHistory' in a && typeof (a as SupportsHistory).getHistory === 'function';
}

/** Type guard: adapter maps NDJSON output to AgendoEventPayloads. */
export function supportsEventMapping(a: AgentAdapter): a is AgentAdapter & SupportsEventMapping {
  return (
    'mapJsonToEvents' in a && typeof (a as SupportsEventMapping).mapJsonToEvents === 'function'
  );
}

/** Type guard: adapter accepts activity callbacks for SDK-internal delta buffering. */
export function supportsActivityCallbacks(
  a: AgentAdapter,
): a is AgentAdapter & SupportsActivityCallbacks {
  return (
    'setActivityCallbacks' in a &&
    typeof (a as SupportsActivityCallbacks).setActivityCallbacks === 'function'
  );
}

/** Type guard: adapter supports sending tool_result messages. */
export function supportsToolResult(a: AgentAdapter): a is AgentAdapter & SupportsToolResult {
  return 'sendToolResult' in a && typeof (a as SupportsToolResult).sendToolResult === 'function';
}

/** Type guard: adapter supports removing a queued message before the SDK consumes it. */
export function supportsCancelQueuedMessage(
  a: AgentAdapter,
): a is AgentAdapter & SupportsCancelQueuedMessage {
  return (
    'cancelQueuedMessage' in a &&
    typeof (a as SupportsCancelQueuedMessage).cancelQueuedMessage === 'function'
  );
}

/** Type guard: adapter supports injecting steering messages into a running turn. */
export function supportsSteer(a: AgentAdapter): a is AgentAdapter & SupportsSteer {
  return 'steer' in a && typeof (a as SupportsSteer).steer === 'function';
}

/** Type guard: adapter supports rolling back turns in the agent thread. */
export function supportsRollback(a: AgentAdapter): a is AgentAdapter & SupportsRollback {
  return 'rollback' in a && typeof (a as SupportsRollback).rollback === 'function';
}

/** Type guard: adapter supports rewinding files to a previous state. */
export function supportsFileCheckpointing(
  a: AgentAdapter,
): a is AgentAdapter & SupportsFileCheckpointing {
  return 'rewindFiles' in a && typeof (a as SupportsFileCheckpointing).rewindFiles === 'function';
}

/** Options struct for SessionProcess.start(), replacing 10 positional parameters. */
export interface SessionStartOptions {
  prompt: string;
  resumeRef?: string;
  spawnCwd?: string;
  envOverrides?: Record<string, string>;
  mcpConfigPath?: string;
  mcpServers?: AcpMcpServer[];
  /** SDK-format MCP servers for Claude SDK adapter (no temp file needed). */
  sdkMcpServers?: SpawnOpts['sdkMcpServers'];
  initialAttachments?: AttachmentRef[];
  displayText?: string;
  resumeSessionAt?: string;
  developerInstructions?: string;
  /** Text to append to Claude's system prompt via SDK systemPrompt.append. */
  appendSystemPrompt?: string;
  /** Client-generated nonce for the resume message — forwarded to user:message SSE event
   *  so the frontend dedup effect can clear the optimistic pill on cold-resume. */
  displayClientId?: string;
}
