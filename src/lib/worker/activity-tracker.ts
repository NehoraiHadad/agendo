import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { AgendoEvent, AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';

/**
 * ActivityTracker manages all timer state, kill-flag state, and delta-buffer
 * state extracted from SessionProcess.
 *
 * Responsibilities:
 *   - Idle timeout: reset/start on each user/agent turn; kills the process on expiry
 *   - Heartbeat: 30s DB update + kill(pid, 0) liveness check
 *   - MCP health check: 60s check for disconnected MCP servers
 *   - Text / thinking delta buffers: 200ms batching for PG NOTIFY throughput
 *
 * Extracted from session-process.ts to keep that file focused on lifecycle
 * and event routing.
 */
export class ActivityTracker {
  // -------------------------------------------------------------------------
  // Kill flags (public so SessionProcess.onExit can read them)
  // -------------------------------------------------------------------------

  /** Set when the idle timer fires and SIGTERM is sent. */
  idleTimeoutKilled = false;
  /**
   * Set by handleInterrupt() in SessionProcess when the process dies during a
   * soft interrupt so onExit transitions to 'idle' instead of 'ended'.
   */
  interruptKilled = false;

  // -------------------------------------------------------------------------
  // Timer handles (private)
  // -------------------------------------------------------------------------

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private mcpHealthTimer: ReturnType<typeof setInterval> | null = null;
  private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------------------
  // Delta buffers (private)
  // -------------------------------------------------------------------------

  private deltaBuffer = '';
  private thinkingDeltaBuffer = '';

  static readonly DELTA_FLUSH_MS = 200;

  constructor(
    private readonly sessionId: string,
    /** Returns effective idle timeout in seconds (accounts for team monitor). */
    private readonly getIdleTimeoutSec: () => number,
    /** Returns the idle timeout message (accounts for team monitor). */
    private readonly getIdleTimeoutMessage: (timeoutSec: number) => string,
    /** Returns the current session status. */
    private readonly getStatus: () => SessionStatus,
    /** Emits an AgendoEvent (for idle timeout and MCP health messages). */
    private readonly emitEvent: (payload: AgendoEventPayload) => Promise<AgendoEvent>,
    /** Kills the managed process (SIGTERM + schedules SIGKILL). */
    private readonly onIdleKill: () => void,
    /** Returns the current managed-process PID for liveness checks. */
    private readonly getPid: () => number | undefined,
    /** Called when the heartbeat detects a silent process crash. */
    private readonly onSilentCrash: () => void,
    /** Adapter method for MCP server status; undefined if the adapter doesn't support it. */
    private readonly getMcpStatus: (() => Promise<Record<string, unknown> | null>) | undefined,
    /** Publishes a batched text-delta event directly to PG NOTIFY (no log write). */
    private readonly publishTextDelta: (text: string) => Promise<void>,
    /** Publishes a batched thinking-delta event directly to PG NOTIFY (no log write). */
    private readonly publishThinkingDelta: (text: string) => Promise<void>,
  ) {}

  // -------------------------------------------------------------------------
  // Idle timer
  // -------------------------------------------------------------------------

  /**
   * Reset (or start) the idle timeout countdown.
   *
   * Call this after every user/agent event so the clock restarts.  If the
   * session has been `awaiting_input` for `idleTimeoutSec` seconds without
   * a new message, SIGTERM is sent.
   */
  recordActivity(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const timeoutSec = this.getIdleTimeoutSec();

    this.idleTimer = setTimeout(() => {
      if (this.getStatus() !== 'awaiting_input') return;
      this.emitEvent({
        type: 'system:info',
        message: this.getIdleTimeoutMessage(timeoutSec),
      })
        .then(() => {
          this.idleTimeoutKilled = true;
          this.onIdleKill();
        })
        .catch((err: unknown) => {
          console.error(
            `[activity-tracker] Failed to emit idle timeout event for session ${this.sessionId}:`,
            err,
          );
          // Still kill the process even if event emission fails.
          this.idleTimeoutKilled = true;
          this.onIdleKill();
        });
    }, timeoutSec * 1_000);
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  /**
   * Start a 30s heartbeat interval that:
   *   1. Updates `sessions.heartbeatAt` in the DB so stale-job detection works.
   *   2. Performs a `kill(pid, 0)` liveness check to detect silent crashes.
   */
  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          await db
            .update(sessions)
            .set({ heartbeatAt: new Date() })
            .where(eq(sessions.id, this.sessionId));
          // Liveness check: kill(pid, 0) throws ESRCH if the process is already dead.
          // This catches silent crashes where the exit handler never fired.
          const pid = this.getPid();
          if (pid) {
            try {
              process.kill(pid, 0);
            } catch {
              console.warn(
                `[activity-tracker] Session ${this.sessionId}: process ${pid} died silently, recovering`,
              );
              this.onSilentCrash();
            }
          }
        } catch (err) {
          console.error(`[activity-tracker] Heartbeat failed for session ${this.sessionId}:`, err);
        }
      })();
    }, 30_000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // MCP health check
  // -------------------------------------------------------------------------

  /**
   * Start a 60s interval that queries the adapter for MCP server status and
   * emits a `system:mcp-status` event when any server is not connected.
   * No-ops when the adapter doesn't expose `getMcpStatus`.
   */
  startMcpHealthCheck(): void {
    if (!this.getMcpStatus) return;
    const getMcpStatus = this.getMcpStatus;
    this.mcpHealthTimer = setInterval(() => {
      void (async () => {
        try {
          const resp = await getMcpStatus();
          if (!resp) return; // timeout or process dead — skip silently
          const servers = Array.isArray(resp.servers)
            ? (resp.servers as Array<{ name: string; status: string }>)
            : [];
          const disconnected = servers.filter(
            (s) => s.status && s.status !== 'connected' && s.status !== 'ready',
          );
          if (disconnected.length > 0) {
            await this.emitEvent({
              type: 'system:mcp-status',
              servers: disconnected,
            });
          }
        } catch (err) {
          console.warn(
            `[activity-tracker] MCP health check failed for session ${this.sessionId}:`,
            err,
          );
        }
      })();
    }, 60_000);
  }

  stopMcpHealthCheck(): void {
    if (this.mcpHealthTimer !== null) {
      clearInterval(this.mcpHealthTimer);
      this.mcpHealthTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Delta buffers
  // -------------------------------------------------------------------------

  /**
   * Append text to the batching buffer. Starts the 200ms flush timer if not
   * already running. The caller should invoke this for each `text_delta`
   * from a `stream_event`.
   */
  appendDelta(text: string): void {
    this.deltaBuffer += text;
    if (!this.deltaFlushTimer) {
      this.deltaFlushTimer = setTimeout(() => {
        void this.flushDeltaBuffer();
      }, ActivityTracker.DELTA_FLUSH_MS);
    }
  }

  /** Append text to the thinking delta buffer. */
  appendThinkingDelta(text: string): void {
    this.thinkingDeltaBuffer += text;
    if (!this.thinkingDeltaFlushTimer) {
      this.thinkingDeltaFlushTimer = setTimeout(() => {
        void this.flushThinkingDeltaBuffer();
      }, ActivityTracker.DELTA_FLUSH_MS);
    }
  }

  /**
   * Flush both delta buffers and cancel their timers.
   * Called when a complete `assistant` message arrives (the deltas are
   * superseded by the full message).
   */
  clearDeltaBuffers(): void {
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer);
      this.deltaFlushTimer = null;
    }
    this.deltaBuffer = '';
    if (this.thinkingDeltaFlushTimer) {
      clearTimeout(this.thinkingDeltaFlushTimer);
      this.thinkingDeltaFlushTimer = null;
    }
    this.thinkingDeltaBuffer = '';
  }

  // -------------------------------------------------------------------------
  // Full cleanup
  // -------------------------------------------------------------------------

  /**
   * Stop all timers and clear all buffers. Called from onExit() before
   * tearing down the session.
   */
  stopAllTimers(): void {
    this.stopHeartbeat();
    this.stopMcpHealthCheck();
    this.clearDeltaBuffers();
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private: flush helpers
  // -------------------------------------------------------------------------

  /**
   * Flush accumulated text deltas as a single agent:text-delta event.
   * Published directly to PG NOTIFY (not written to the log file) because
   * the complete agent:text event from the `assistant` message is the source
   * of truth.
   */
  private async flushDeltaBuffer(): Promise<void> {
    this.deltaFlushTimer = null;
    const text = this.deltaBuffer;
    if (!text) return;
    this.deltaBuffer = '';
    await this.publishTextDelta(text);
  }

  /** Flush accumulated thinking deltas as a single agent:thinking-delta event. */
  private async flushThinkingDeltaBuffer(): Promise<void> {
    this.thinkingDeltaFlushTimer = null;
    const text = this.thinkingDeltaBuffer;
    if (!text) return;
    this.thinkingDeltaBuffer = '';
    await this.publishThinkingDelta(text);
  }
}
