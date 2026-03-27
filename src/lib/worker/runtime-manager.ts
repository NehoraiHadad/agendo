/**
 * RuntimeManager — owns the in-memory Maps of active SessionProcess instances.
 *
 * Extracted from session-runner.ts (liveSessionProcs + allSessionProcs) to
 * centralise registration, lookup, and shutdown in a single class.
 *
 * - `allProcs` (superset): registered immediately when runSession starts.
 * - `liveProcs`: added when the session releases its pg-boss slot (awaiting_input).
 *
 * The class is a singleton created in worker/index.ts and shared with
 * session-runner.ts and worker-http.ts.
 */

import { createLogger } from '@/lib/logger';
import type { SessionProcess } from '@/lib/worker/session-process';

const log = createLogger('runtime-manager');

export class RuntimeManager {
  private liveProcs = new Map<string, SessionProcess>();
  private allProcs = new Map<string, SessionProcess>();

  readonly workerId: string;

  constructor(workerId: string) {
    this.workerId = workerId;
  }

  /** Register a new session process (called at start of runSession). */
  register(sessionId: string, proc: SessionProcess): void {
    this.allProcs.set(sessionId, proc);
  }

  /** Move to live map (called when slot is released / first awaiting_input). */
  markLive(sessionId: string): void {
    const proc = this.allProcs.get(sessionId);
    if (!proc) return;
    this.liveProcs.set(sessionId, proc);
  }

  /**
   * Remove from both maps (called on process exit).
   * Only deletes if the entry still points to the SAME proc reference —
   * a later runSession call may have legitimately replaced the entry.
   */
  remove(sessionId: string, proc: SessionProcess): void {
    if (this.allProcs.get(sessionId) === proc) {
      this.allProcs.delete(sessionId);
    }
    if (this.liveProcs.get(sessionId) === proc) {
      this.liveProcs.delete(sessionId);
    }
  }

  /** Check if session already has a registered process. */
  has(sessionId: string): boolean {
    return this.allProcs.has(sessionId);
  }

  /** Get a process by session ID (checks allProcs — full lifecycle). */
  getProcess(sessionId: string): SessionProcess | undefined {
    return this.allProcs.get(sessionId);
  }

  /** Count of all registered sessions (superset). */
  get activeCount(): number {
    return this.allProcs.size;
  }

  /** Count of live (post-slot-release) sessions. */
  get liveCount(): number {
    return this.liveProcs.size;
  }

  /**
   * SYNCHRONOUSLY mark every known process as terminating.
   * Called before any `await` in the shutdown handler so that
   * `terminateKilled` is set before the I/O tick that fires onExit.
   */
  markAllTerminating(): void {
    for (const proc of this.allProcs.values()) {
      proc.markTerminating();
    }
  }

  /** Terminate all live sessions and wait for exit (up to graceMs). */
  async shutdown(graceMs: number): Promise<void> {
    if (this.liveProcs.size === 0) return;

    log.info({ count: this.liveProcs.size }, 'Terminating live sessions');
    const exitPromises = [...this.liveProcs.values()].map((proc) => {
      proc.terminate();
      return proc.waitForExit();
    });
    await Promise.race([
      Promise.allSettled(exitPromises),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }

  /** Get all live (post-slot-release) processes. */
  getLiveProcs(): SessionProcess[] {
    return [...this.liveProcs.values()];
  }

  /** Get all registered processes. */
  getAllProcs(): SessionProcess[] {
    return [...this.allProcs.values()];
  }
}
