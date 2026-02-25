export type PermissionMode = 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';

export type PermissionDecision =
  | 'allow'
  | 'deny'
  | 'allow-session'
  | { behavior: 'allow'; updatedInput: Record<string, unknown> };

/** Full context of a tool approval request, passed to the ApprovalHandler. */
export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** True when this is an AskUserQuestion interactive prompt (not a permission gate). */
  isAskUser: boolean;
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
  /** When true, omit -p (print mode) so the process stays alive for multi-turn sessions. */
  persistentSession?: boolean;
  /** Controls per-tool-call gating within a running session. Default: 'default' (ask). */
  permissionMode?: PermissionMode;
  /** Tool name patterns already approved for this session (from session.allowedTools). */
  allowedTools?: string[];
  /** MCP servers to inject via ACP session/new (Gemini only). */
  mcpServers?: AcpMcpServer[];
  /** Initial image to attach to the first user message (for cold resumes with image attachments). */
  initialImage?: ImageContent;
  /** Max budget in USD for this session. Claude will stop when exceeded. */
  maxBudgetUsd?: number;
  /** Fallback model when primary model is overloaded. */
  fallbackModel?: string;
  /** When true, only use MCP servers from the provided config (ignore global). */
  strictMcpConfig?: boolean;
  /** Force a specific session UUID (syncs with agendo's session ID). */
  sessionId?: string;
  /** Text to append to Claude's system prompt (e.g., MCP context preamble). */
  appendSystemPrompt?: string;
}

export interface ManagedProcess {
  pid: number;
  tmuxSession: string;
  stdin: NodeJS.WritableStream | null; // Direct stdin access for hot messages
  kill: (signal: NodeJS.Signals) => void;
  onData: (cb: (chunk: string) => void) => void;
  onExit: (cb: (code: number | null) => void) => void;
}

export interface ImageContent {
  mimeType: string;
  data: string; // base64 encoded
}

/** Callback type injected by SessionProcess to handle per-tool approval requests. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<PermissionDecision>;

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
  setApprovalHandler(handler: ApprovalHandler): void;
  onSessionRef?(cb: (ref: string) => void): void;
  /** Change the permission mode in-place via control_request (no process restart). */
  setPermissionMode?(mode: string): Promise<boolean>;
  /** Switch the AI model in-place via control_request. */
  setModel?(model: string): Promise<boolean>;
  /** Query MCP server connection status via control_request. */
  getMcpStatus?(): Promise<Record<string, unknown> | null>;
}
