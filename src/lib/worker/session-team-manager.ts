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
import { TeamTaskMonitor, type TeamTask } from '@/lib/worker/team-task-monitor';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-team-manager');

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
  /** Claude CLI session ref (from session:init). Needed for subagent transcript path. */
  sessionRef?: string;
  /** Project working directory. Needed for subagent transcript path. */
  projectPath?: string;
}

/** Pending subagent: waiting for transcript file to appear. */
interface PendingSubagent {
  toolUseId: string;
  subagentType?: string;
  description?: string;
}

export class SessionTeamManager {
  private monitor: TeamInboxMonitor | null = null;
  private taskMonitor: TeamTaskMonitor | null = null;
  private configPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastMemberCount = 0;
  private pendingCreateId: string | null = null;
  /** Pending subagent Tool call: toolUseId → pending info. */
  private pendingSubagentByToolUseId: Map<string, PendingSubagent> = new Map();
  /**
   * Team messages that arrived while the session was not yet awaiting_input.
   * Drained into stdin on the next poll cycle once the session is ready.
   */
  private pendingInjections: string[] = [];

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
      // Extract team_name from the TeamCreate result JSON so we don't rely on
      // leadSessionId matching (Claude CLI writes its own internal session ID,
      // not the Agendo session UUID).
      const resultText = this.extractTextContent(event.content);
      const teamNameMatch = resultText.match(/"team_name"\s*:\s*"([^"]+)"/);
      this.tryAttach(teamNameMatch?.[1] ?? null);
    }
    if (event.type === 'agent:tool-start' && event.toolName === 'TeamDelete') {
      if (this.monitor) {
        log.info({ sessionId: this.cb.sessionId }, 'TeamDelete detected, detaching monitor');
        void this.cb.emitEvent({
          type: 'system:info',
          message: 'Team deleted — normal idle timeout restored.',
        });
        this.detachMonitors();
        this.cb.recordActivity();
      }
    }

    // Subagent tracking: watch for Task tool calls
    if (
      event.type === 'agent:tool-start' &&
      (event.toolName === 'Task' || event.toolName === 'Agent')
    ) {
      const input = event.input as Record<string, unknown>;
      this.pendingSubagentByToolUseId.set(event.toolUseId, {
        toolUseId: event.toolUseId,
        subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
        description: typeof input.description === 'string' ? input.description : undefined,
      });
    }

    if (event.type === 'agent:tool-end' && this.pendingSubagentByToolUseId.has(event.toolUseId)) {
      const pending = this.pendingSubagentByToolUseId.get(event.toolUseId);
      this.pendingSubagentByToolUseId.delete(event.toolUseId);
      if (!pending) return;

      // Extract agentId from the tool result content
      const contentText = this.extractTextContent(event.content);

      // Skip team member spawns (they have "agent_id: name@team-name" format)
      if (/agent_id: \S+@\S+/.test(contentText)) {
        return;
      }

      // Regular subagent: extract agentId
      const agentIdMatch = contentText.match(/agentId: ([a-f0-9]+)/);
      if (!agentIdMatch) return;

      const agentId = agentIdMatch[1];
      void this.cb.emitEvent({
        type: 'subagent:start',
        agentId,
        toolUseId: pending.toolUseId,
        subagentType: pending.subagentType,
        description: pending.description,
      });
    }
  }

  /**
   * Build the current team state as AgendoEventPayload[] from live sources
   * (filesystem inbox/config/tasks). Used for SSE reconnect catchup instead
   * of replaying stale events from the log file.
   *
   * Returns an empty array if no team is active.
   */
  getTeamState(): AgendoEventPayload[] {
    if (!this.monitor || !this.taskMonitor) return [];

    const events: AgendoEventPayload[] = [];

    // 1. Team config (members, team name)
    const config = this.monitor.readConfig();
    if (config) {
      events.push({
        type: 'team:config',
        teamName: config.name,
        members: config.members,
      });
    }

    // 2. All inbox messages (teammate → lead)
    for (const msg of this.monitor.readAllMessages()) {
      events.push({
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

    // 3. All outbox messages (lead → teammates)
    for (const { toAgent, message: msg } of this.monitor.readAllOutboxMessages()) {
      events.push({
        type: 'team:outbox-message',
        toAgent,
        fromAgent: msg.from,
        text: msg.text,
        summary: msg.summary,
        color: msg.color,
        sourceTimestamp: msg.timestamp,
        isStructured: msg.isStructured,
        structuredPayload: msg.structuredPayload,
      });
    }

    // 4. Tasks snapshot
    const tasks = this.taskMonitor.readAllTasks();
    if (tasks.length > 0) {
      events.push({ type: 'team:task-update', tasks });
    }

    return events;
  }

  /** Stop polling and detach the monitor. Call on session exit or terminate. */
  stop(): void {
    this.detachMonitors();
  }

  private detachMonitors(): void {
    if (this.monitor) {
      this.monitor.stopPolling();
      this.monitor.stopOutboxPolling();
      this.monitor = null;
    }
    if (this.taskMonitor) {
      this.taskMonitor.stopPolling();
      this.taskMonitor = null;
    }
    if (this.configPollTimer !== null) {
      clearInterval(this.configPollTimer);
      this.configPollTimer = null;
    }
    this.pendingInjections = [];
  }

  /**
   * Inject any queued team messages that arrived while the session was active.
   * Called at the start of each poll cycle and from session-process when
   * the session transitions to awaiting_input.
   */
  drainPendingInjections(): void {
    if (this.pendingInjections.length === 0) return;
    if (this.cb.getStatus() !== 'awaiting_input') return;
    const toInject = this.pendingInjections.splice(0);
    for (const text of toInject) {
      this.cb.pushMessage(text).catch((err: unknown) => {
        log.error({ err }, 'Failed to inject queued team message');
      });
    }
  }

  private tryAttach(teamNameHint?: string | null): boolean {
    if (this.monitor) return true;
    const teamName = teamNameHint ?? TeamInboxMonitor.findTeamForSession(this.cb.sessionId);
    if (!teamName) return false;

    log.info({ teamName, sessionId: this.cb.sessionId }, 'Team detected');
    this.monitor = new TeamInboxMonitor(teamName);
    this.taskMonitor = new TeamTaskMonitor(teamName);

    // Emit initial team:config event
    this.emitTeamConfig();

    // Poll config every 5s to catch new member additions
    this.lastMemberCount = this.monitor.readConfig()?.members.length ?? 0;
    this.configPollTimer = setInterval(() => {
      const config = this.monitor?.readConfig();
      if (config && config.members.length !== this.lastMemberCount) {
        this.lastMemberCount = config.members.length;
        this.emitTeamConfig();
      }
    }, 5000);

    // Start task monitor polling — emit team:task-update on changes
    this.taskMonitor.startPolling(4000, (tasks: TeamTask[]) => {
      void this.cb.emitEvent({
        type: 'team:task-update',
        tasks,
      });
    });

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

      // Drain any previously queued injections now that we may be awaiting_input.
      this.drainPendingInjections();

      // In stream-json mode (agendo sessions) team messages do NOT arrive as a
      // new stdin turn automatically. Inject content messages into stdin so the
      // lead agent wakes up and processes the teammate's report. Structured
      // protocol messages (idle_notification, shutdown_approved, etc.) are
      // internal bookkeeping — skip them.
      //
      // If the session is currently active (Claude is mid-turn), queue the
      // message — it will be injected once the session is awaiting_input again.
      if (!msg.isStructured) {
        const teamText = `[Message from teammate ${msg.from}]:\n${msg.text}`;
        if (this.cb.getStatus() === 'awaiting_input') {
          this.cb.pushMessage(teamText).catch((err: unknown) => {
            log.error({ err, from: msg.from }, 'Failed to inject team message');
          });
        } else {
          this.pendingInjections.push(teamText);
          log.debug({ from: msg.from, status: this.cb.getStatus() }, 'Queued team message');
        }
      }

      // Check if this shutdown_approved completes the full set.
      if (msg.isStructured && msg.structuredPayload?.type === 'shutdown_approved') {
        if (this.monitor?.isTeamDisbanded()) {
          log.info({ sessionId: this.cb.sessionId }, 'Team disbanded');
          void this.cb.emitEvent({
            type: 'system:info',
            message: 'All teammates shut down — normal idle timeout restored.',
          });
          this.detachMonitors();
          this.cb.recordActivity();
        }
      }
    });

    // Start outbox polling — emit team:outbox-message for lead→teammate messages
    this.monitor.startOutboxPolling(4000, (toAgent, msg) => {
      void this.cb.emitEvent({
        type: 'team:outbox-message',
        toAgent,
        fromAgent: msg.from,
        text: msg.text,
        summary: msg.summary,
        color: msg.color,
        sourceTimestamp: msg.timestamp,
        isStructured: msg.isStructured,
        structuredPayload: msg.structuredPayload,
      });
    });

    // Emit initial task snapshot if tasks already exist
    const initialTasks = this.taskMonitor.readAllTasks();
    if (initialTasks.length > 0) {
      void this.cb.emitEvent({
        type: 'team:task-update',
        tasks: initialTasks,
      });
    }

    void this.cb.emitEvent({
      type: 'system:info',
      message: `Team "${teamName}" detected — idle timeout extended while teammates are active.`,
    });

    this.cb.recordActivity();
    return true;
  }

  private emitTeamConfig(): void {
    if (!this.monitor) return;
    const config = this.monitor.readConfig();
    if (!config) return;
    void this.cb.emitEvent({
      type: 'team:config',
      teamName: config.name,
      members: config.members,
    });
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return (content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
    }
    return '';
  }
}
