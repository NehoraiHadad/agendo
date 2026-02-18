export interface SpawnOpts {
  cwd: string;
  env: Record<string, string>;
  executionId: string;
  timeoutSec: number;
  maxOutputBytes: number;
  extraArgs?: string[];
  /** When true, omit -p (print mode) so the process stays alive for multi-turn sessions. */
  persistentSession?: boolean;
}

export interface ManagedProcess {
  pid: number;
  tmuxSession: string;
  stdin: NodeJS.WritableStream | null;  // Direct stdin access for hot messages
  kill: (signal: NodeJS.Signals) => void;
  onData: (cb: (chunk: string) => void) => void;
  onExit: (cb: (code: number | null) => void) => void;
}

export interface ImageContent {
  mimeType: string;
  data: string; // base64 encoded
}

export interface AgentAdapter {
  spawn(prompt: string, opts: SpawnOpts): ManagedProcess;
  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess;
  extractSessionId(output: string): string | null;
  sendMessage(message: string, image?: ImageContent): Promise<void>;  // Now required
  interrupt(): void;         // Now required
  isAlive(): boolean;        // NEW
}
