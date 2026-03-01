import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type {
  AgentAdapter,
  ToolApprovalFn,
  ImageContent,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';

/**
 * Abstract base class for all agent adapters.
 *
 * Provides shared state (callback fields) and utility methods that are
 * identical across ClaudeAdapter, CodexAdapter, and GeminiAdapter.
 * Adapter-specific protocol logic (ACP, NDJSON control_request, etc.)
 * stays in the concrete subclasses.
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  // -------------------------------------------------------------------------
  // Shared callback fields (identical in all 3 adapters)
  // -------------------------------------------------------------------------

  protected thinkingCallback: ((thinking: boolean) => void) | null = null;
  protected approvalHandler: ToolApprovalFn | null = null;
  /** Callback to notify session-process when a stable session reference is known. */
  protected sessionRefCallback: ((ref: string) => void) | null = null;

  // -------------------------------------------------------------------------
  // AgentAdapter interface — shared concrete implementations
  // -------------------------------------------------------------------------

  onThinkingChange(cb: (thinking: boolean) => void): void {
    this.thinkingCallback = cb;
  }

  setApprovalHandler(handler: ToolApprovalFn): void {
    this.approvalHandler = handler;
  }

  onSessionRef(cb: (ref: string) => void): void {
    this.sessionRefCallback = cb;
  }

  // -------------------------------------------------------------------------
  // AgentAdapter interface — abstract (must be implemented by each adapter)
  // -------------------------------------------------------------------------

  abstract spawn(prompt: string, opts: SpawnOpts): ManagedProcess;
  abstract resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess;
  abstract extractSessionId(output: string): string | null;
  abstract sendMessage(message: string, image?: ImageContent): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract isAlive(): boolean;

  // -------------------------------------------------------------------------
  // Protected static utilities (shared across adapters)
  // -------------------------------------------------------------------------

  /** Grace period before SIGKILL escalation (5 seconds — Codex standard). */
  protected static readonly SIGKILL_DELAY_MS = 5_000;

  /**
   * Splits a partial NDJSON line buffer + new data into complete lines.
   *
   * Usage:
   *   const { lines, remainder } = BaseAgentAdapter.processLineBuffer(this.lineBuffer, newText);
   *   this.lineBuffer = remainder;
   *   for (const line of lines) { ... }
   */
  protected static processLineBuffer(
    buffer: string,
    newText: string,
  ): { lines: string[]; remainder: string } {
    const combined = buffer + newText;
    const parts = combined.split('\n');
    const remainder = parts.pop() ?? '';
    return { lines: parts, remainder };
  }

  /**
   * SIGTERM → wait → SIGKILL escalation for a child process group.
   * Used by CodexAdapter.interrupt(); Claude and Gemini have unique interrupt logic.
   */
  protected static async killWithGrace(cp: ChildProcess, delayMs: number): Promise<void> {
    if (!cp.pid) return;
    try {
      process.kill(-cp.pid, 'SIGTERM');
    } catch {
      return; // Already dead
    }
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        cp.once('exit', () => resolve(true));
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), delayMs)),
    ]);
    if (!exited) {
      try {
        process.kill(-cp.pid, 'SIGKILL');
      } catch {
        /* Already dead */
      }
    }
  }

  /**
   * Spawn a process detached from the parent process group.
   * All adapters use the same nodeSpawn options + cp.unref() pattern.
   */
  protected static spawnDetached(
    binary: string,
    args: string[],
    opts: Pick<SpawnOpts, 'cwd' | 'env'>,
  ): ChildProcess {
    const cp = nodeSpawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    cp.unref();
    return cp;
  }

  /**
   * Build a kill function that sends a signal to the entire process group.
   * All adapters use this identical pattern.
   */
  protected static buildKill(
    getProcess: () => ChildProcess | null | undefined,
  ): ManagedProcess['kill'] {
    return (signal) => {
      const p = getProcess();
      if (!p?.pid) return;
      try {
        process.kill(-p.pid, signal);
      } catch {
        /* Process group already dead */
      }
    };
  }
}
