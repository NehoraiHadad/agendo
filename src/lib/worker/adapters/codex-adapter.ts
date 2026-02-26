import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import { mapCodexJsonToEvents, type CodexEvent } from '@/lib/worker/adapters/codex-event-mapper';
import type {
  AgentAdapter,
  ApprovalHandler,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';
import type { AgendoEventPayload } from '@/lib/realtime/events';

const SIGKILL_DELAY_MS = 5_000;

/**
 * Permission mode → Codex exec flags.
 */
function permissionFlags(mode?: string): string[] {
  switch (mode) {
    case 'bypassPermissions':
    case 'dontAsk':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'plan':
      return ['--sandbox', 'read-only'];
    case 'acceptEdits':
    case 'default':
    default:
      return ['--sandbox', 'workspace-write'];
  }
}

/**
 * Permission mode → flags valid for `codex exec resume`.
 *
 * `codex exec resume` does NOT accept `--cd` or `--sandbox`.
 * Valid permission-related flags: `--dangerously-bypass-approvals-and-sandbox`, `--full-auto`.
 * `--full-auto` is the closest safe match (= `--sandbox workspace-write` + `--ask-for-approval on-request`).
 */
function resumePermissionFlags(mode?: string): string[] {
  switch (mode) {
    case 'bypassPermissions':
    case 'dontAsk':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    default:
      return ['--full-auto'];
  }
}

/**
 * STDIO-based adapter for the Codex CLI.
 *
 * Unlike Claude (persistent process, messages via stdin), Codex spawns a
 * NEW `codex exec` process per turn. The adapter returns a "virtual"
 * ManagedProcess from spawn() with **stable callback arrays** that persist
 * across process replacements. When sendMessage() is called, the old
 * process is cleaned up and a new `codex exec resume <threadId>` process
 * is spawned wired to the same callbacks.
 */
export class CodexAdapter implements AgentAdapter {
  private threadId: string | null = null;
  private storedOpts: SpawnOpts | null = null;
  private currentChild: ChildProcess | null = null;
  private alive = false;
  private tmuxSessionName = '';

  // Stable callback arrays that persist across child process replacements.
  // The virtual ManagedProcess returned by spawn() references these.
  private dataCallbacks: Array<(chunk: string) => void> = [];
  private exitCallbacks: Array<(code: number | null) => void> = [];

  private thinkingCallback: ((thinking: boolean) => void) | null = null;
  private approvalHandler: ApprovalHandler | null = null;
  private sessionRefCallback: ((ref: string) => void) | null = null;

  /** NDJSON line buffer for partial lines split across data chunks. */
  private lineBuffer = '';

  // -----------------------------------------------------------------------
  // AgentAdapter interface
  // -----------------------------------------------------------------------

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    this.storedOpts = opts;
    this.dataCallbacks = [];
    this.exitCallbacks = [];
    this.tmuxSessionName = `codex-${opts.executionId}`;
    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    this.spawnExec(prompt, opts, null);
    return this.buildVirtualProcess();
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.threadId = sessionRef;
    this.storedOpts = opts;
    this.dataCallbacks = [];
    this.exitCallbacks = [];
    this.tmuxSessionName = `codex-${opts.executionId}`;
    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    this.spawnExec(prompt, opts, sessionRef);
    return this.buildVirtualProcess();
  }

  extractSessionId(_output: string): string | null {
    return this.threadId;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.threadId) {
      throw new Error('No Codex thread ID — cannot send follow-up message');
    }
    if (!this.storedOpts) {
      throw new Error('No stored opts for Codex session');
    }

    // Kill the old process if still running (shouldn't be, but be safe)
    this.killCurrentChild();

    // Spawn a new resume process wired to the same stable callbacks
    this.spawnExec(message, this.storedOpts, this.threadId);
  }

  async interrupt(): Promise<void> {
    const cp = this.currentChild;
    if (!cp?.pid) return;

    // SIGTERM the process group
    try {
      process.kill(-cp.pid, 'SIGTERM');
    } catch {
      // Already dead
      return;
    }

    // Wait for exit or escalate to SIGKILL
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        cp.once('exit', () => resolve(true));
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SIGKILL_DELAY_MS)),
    ]);

    if (!exited) {
      try {
        process.kill(-cp.pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  onThinkingChange(cb: (thinking: boolean) => void): void {
    this.thinkingCallback = cb;
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  onSessionRef(cb: (ref: string) => void): void {
    this.sessionRefCallback = cb;
  }

  async setModel(model: string): Promise<boolean> {
    if (!this.storedOpts) return false;
    this.storedOpts = { ...this.storedOpts, model };
    return true;
  }

  /**
   * Maps a Codex JSONL parsed object to AgendoEventPayloads.
   * Used by session-process.ts to delegate event mapping.
   */
  mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    return mapCodexJsonToEvents(parsed as CodexEvent);
  }

  // -----------------------------------------------------------------------
  // Private: spawn a `codex exec` child process
  // -----------------------------------------------------------------------

  private spawnExec(prompt: string, opts: SpawnOpts, resumeThreadId: string | null): void {
    this.lineBuffer = '';

    const args = ['exec'];
    if (resumeThreadId) {
      args.push('resume', resumeThreadId);
    }
    args.push(prompt);
    args.push('--json');

    if (resumeThreadId) {
      // `codex exec resume` does NOT accept --cd or --sandbox flags.
      // cwd is already set via nodeSpawn's cwd option.
      args.push(...resumePermissionFlags(opts.permissionMode));
    } else {
      args.push('--cd', opts.cwd);
      args.push(...permissionFlags(opts.permissionMode));
    }

    if (opts.model) {
      args.push('-m', opts.model);
    }
    if (opts.extraArgs) {
      args.push(...opts.extraArgs);
    }

    const cp = nodeSpawn('codex', args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    cp.unref();

    this.currentChild = cp;
    this.alive = true;

    cp.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');

      // Forward raw text to data callbacks (session-process logs it)
      for (const cb of this.dataCallbacks) cb(text);

      // Parse NDJSON lines for adapter-level signals
      this.processLines(text);
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of this.dataCallbacks) cb(text);
    });

    cp.on('exit', (code) => {
      // If this is the current child, mark as not alive
      if (cp === this.currentChild) {
        this.alive = false;
        this.currentChild = null;
      }

      // Fire exit callbacks for turn.completed + exit(0) flow
      // and for abnormal exits. The virtual process uses these
      // to notify session-process of lifecycle changes.
      for (const cb of this.exitCallbacks) cb(code);
    });
  }

  /**
   * Build the virtual ManagedProcess that persists across child replacements.
   */
  private buildVirtualProcess(): ManagedProcess {
    return {
      pid: this.currentChild?.pid ?? 0,
      tmuxSession: this.tmuxSessionName,
      stdin: null, // Codex exec does not accept stdin
      kill: (signal) => {
        const cp = this.currentChild;
        if (!cp?.pid) return;
        try {
          process.kill(-cp.pid, signal);
        } catch {
          // Process group already dead
        }
      },
      onData: (cb) => this.dataCallbacks.push(cb),
      onExit: (cb) => this.exitCallbacks.push(cb),
    };
  }

  /**
   * Process buffered NDJSON lines, extracting thread ID and thinking state.
   */
  private processLines(text: string): void {
    const combined = this.lineBuffer + text;
    const lines = combined.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const type = parsed.type as string | undefined;

        // Extract thread ID from thread.started
        if (type === 'thread.started' && parsed.thread_id && !this.threadId) {
          this.threadId = parsed.thread_id as string;
          this.sessionRefCallback?.(this.threadId);
        }

        // Thinking state management
        if (type === 'turn.started') {
          this.thinkingCallback?.(true);
        }
        if (type === 'turn.completed' || type === 'turn.failed') {
          this.thinkingCallback?.(false);
        }
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  /**
   * Kill the current child process (best-effort).
   */
  private killCurrentChild(): void {
    const cp = this.currentChild;
    if (!cp?.pid) return;
    try {
      process.kill(-cp.pid, 'SIGTERM');
    } catch {
      // Already dead
    }
    this.currentChild = null;
  }
}
