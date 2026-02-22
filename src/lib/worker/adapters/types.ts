export type PermissionMode = 'default' | 'bypassPermissions' | 'acceptEdits';

export type PermissionDecision = 'allow' | 'deny' | 'allow-session';

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
export type ApprovalHandler = (
  approvalId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<PermissionDecision>;

export interface AgentAdapter {
  spawn(prompt: string, opts: SpawnOpts): ManagedProcess;
  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess;
  extractSessionId(output: string): string | null;
  sendMessage(message: string, image?: ImageContent): Promise<void>;
  interrupt(): Promise<void>;
  isAlive(): boolean;
  onThinkingChange(cb: (thinking: boolean) => void): void;
  setApprovalHandler(handler: ApprovalHandler): void;
  onSessionRef?(cb: (ref: string) => void): void;
}
