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
  /** Initial image to attach to the first user message (for cold resumes with image attachments). */
  initialImage?: ImageContent;
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
  pid: number;
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

export interface ImageContent {
  mimeType: string;
  data: string; // base64 encoded
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

export interface AgentAdapter {
  spawn(prompt: string, opts: SpawnOpts): ManagedProcess;
  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess;
  extractSessionId(output: string): string | null;
  sendMessage(message: string, image?: ImageContent): Promise<void>;
  /** Send a tool_result NDJSON message for a pending tool_use (e.g. AskUserQuestion). Optional — only Claude supports this. */
  sendToolResult?(toolUseId: string, content: string): Promise<void>;
  interrupt(): Promise<void>;
  isAlive(): boolean;
  onThinkingChange(cb: (thinking: boolean) => void): void;
  setApprovalHandler(handler: ToolApprovalFn): void;
  onSessionRef?(cb: (ref: string) => void): void;
  /** Change the permission mode in-place via control_request (no process restart). */
  setPermissionMode?(mode: string): Promise<boolean>;
  /** Switch the AI model in-place via control_request. */
  setModel?(model: string): Promise<boolean>;
  /** Query MCP server connection status via control_request. */
  getMcpStatus?(): Promise<Record<string, unknown> | null>;
  /** Replace all MCP servers on a live session (Claude SDK only). */
  setMcpServers?(servers: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** Reconnect a specific MCP server by name (Claude SDK only). */
  reconnectMcpServer?(serverName: string): Promise<void>;
  /** Enable/disable a specific MCP server by name (Claude SDK only). */
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<void>;
  /** Rewind files to the state at a given user message (requires enableFileCheckpointing, Claude SDK only). */
  rewindFiles?(userMessageId: string, dryRun?: boolean): Promise<Record<string, unknown> | null>;
  /** Inject a steering message into the current running turn (Codex only). */
  steer?(message: string): Promise<void>;
  /** Rollback the last N turns in the thread (Codex only). */
  rollback?(numTurns?: number): Promise<void>;
  /** Inject activity callbacks for SDK adapters that handle stream_event delta buffering
   *  internally. Called by SessionProcess before start(). */
  setActivityCallbacks?(callbacks: ActivityCallbacks): void;
  /** Map a parsed JSON line from the agent's STDIO output to AgendoEventPayloads.
   *  Used by SessionDataPipeline for adapter-specific event parsing. */
  mapJsonToEvents?(
    parsed: Record<string, unknown>,
  ): import('@/lib/realtime/events').AgendoEventPayload[];
  /** The last captured assistant message UUID, used for conversation branching (Claude only). */
  lastAssistantUuid?: string;
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
  initialImage?: ImageContent;
  displayText?: string;
  resumeSessionAt?: string;
  developerInstructions?: string;
}
