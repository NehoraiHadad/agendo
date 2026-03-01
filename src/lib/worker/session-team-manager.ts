/**
 * SessionTeamManager — handles team inbox monitoring and team lifecycle events
 * for a long-running session that acts as a team leader.
 *
 * Extracted from SessionProcess to keep session-process.ts focused on core
 * session lifecycle. This class wraps TeamInboxMonitor and reacts to
 * TeamCreate/TeamDelete tool events from the agent's NDJSON output.
 */

import type { AgendoEventPayload } from '@/lib/realtime/events';
import { TeamInboxMonitor } from '@/lib/worker/team-inbox-monitor';

export interface SessionTeamManagerCallbacks {
  /** Emit an event to the session channel. */
  emitEvent(payload: AgendoEventPayload): Promise<void>;
  /** Reset the idle activity timer. */
  recordActivity(): void;
  /** Inject a user message into the agent's stdin. */
  pushMessage(text: string): Promise<void>;
  /** Current session status (used to guard stdin injection). */
  getStatus(): string;
  /** Session ID for logging. */
  sessionId: string;
}

export class SessionTeamManager {
  private monitor: TeamInboxMonitor | null = null;
  private pendingCreateId: string | null = null;

  constructor(private readonly cb: SessionTeamManagerCallbacks) {}

  /** Returns true while this session has an active team inbox monitor. */
  get isActive(): boolean {
    return this.monitor !== null;
  }

  /**
   * Called once at session start. Attaches a monitor immediately if a team
   * already exists on disk (cold-resume). Otherwise, team detection is
   * event-driven via onToolEvent().
   */
  start(): void {
    this.tryAttach();
  }

  /**
   * React to tool events from the agent's NDJSON output.
   * Must be called for every agent:tool-start and agent:tool-end event.
   */
  onToolEvent(event: AgendoEventPayload): void {
    if (event.type === 'agent:tool-start' && event.toolName === 'TeamCreate') {
      this.pendingCreateId = event.toolUseId;
    }
    if (event.type === 'agent:tool-end' && this.pendingCreateId === event.toolUseId) {
      this.pendingCreateId = null;
      this.tryAttach();
    }
    if (event.type === 'agent:tool-start' && event.toolName === 'TeamDelete') {
      if (this.monitor) {
        console.log(
          `[session-team-manager] TeamDelete detected — detaching monitor for session ${this.cb.sessionId}`,
        );
        void this.cb.emitEvent({
          type: 'system:info',
          message: 'Team deleted — normal idle timeout restored.',
        });
        this.monitor.stopPolling();
        this.monitor = null;
        this.cb.recordActivity();
      }
    }
  }

  /** Stop polling and detach the monitor. Call on session exit or terminate. */
  stop(): void {
    if (this.monitor) {
      this.monitor.stopPolling();
      this.monitor = null;
    }
  }

  private tryAttach(): boolean {
    if (this.monitor) return true;
    const teamName = TeamInboxMonitor.findTeamForSession(this.cb.sessionId);
    if (!teamName) return false;

    console.log(
      `[session-team-manager] Team detected: "${teamName}" for session ${this.cb.sessionId}`,
    );
    this.monitor = new TeamInboxMonitor(teamName);

    // Backfill: emit all messages that already existed in the inbox so they
    // appear in the chat view on reconnect / cold-resume.
    for (const msg of this.monitor.readAllMessages()) {
      void this.cb.emitEvent({
        type: 'team:message',
        fromAgent: msg.from,
        text: msg.text,
        summary: msg.summary,
        color: msg.color,
        sourceTimestamp: msg.timestamp,
        isStructured: msg.isStructured,
        structuredPayload: msg.structuredPayload,
      });
    }

    // Poll for new messages every 4s — reset idle timer on each message.
    this.monitor.startPolling(4000, (msg) => {
      void this.cb.emitEvent({
        type: 'team:message',
        fromAgent: msg.from,
        text: msg.text,
        summary: msg.summary,
        color: msg.color,
        sourceTimestamp: msg.timestamp,
        isStructured: msg.isStructured,
        structuredPayload: msg.structuredPayload,
      });

      // Team inbox activity proves teammates are working — reset idle timer.
      this.cb.recordActivity();

      // In stream-json mode (agendo sessions) team messages do NOT arrive as a
      // new stdin turn automatically. Inject content messages into stdin so the
      // lead agent wakes up and processes the teammate's report. Structured
      // protocol messages (idle_notification, shutdown_approved, etc.) are
      // internal bookkeeping — skip them.
      if (!msg.isStructured && this.cb.getStatus() === 'awaiting_input') {
        const teamText = `[Message from teammate ${msg.from}]:\n${msg.text}`;
        this.cb.pushMessage(teamText).catch((err: unknown) => {
          console.error(
            `[session-team-manager] Failed to inject team message from ${msg.from}:`,
            err,
          );
        });
      }

      // Check if this shutdown_approved completes the full set.
      if (msg.isStructured && msg.structuredPayload?.type === 'shutdown_approved') {
        if (this.monitor?.isTeamDisbanded()) {
          console.log(`[session-team-manager] Team disbanded for session ${this.cb.sessionId}`);
          void this.cb.emitEvent({
            type: 'system:info',
            message: 'All teammates shut down — normal idle timeout restored.',
          });
          this.monitor.stopPolling();
          this.monitor = null;
          this.cb.recordActivity();
        }
      }
    });

    void this.cb.emitEvent({
      type: 'system:info',
      message: `Team "${teamName}" detected — idle timeout extended while teammates are active.`,
    });

    this.cb.recordActivity();
    return true;
  }
}
