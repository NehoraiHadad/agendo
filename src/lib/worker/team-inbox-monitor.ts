import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// TeamConfig types
// ---------------------------------------------------------------------------

export interface TeamConfigMember {
  name: string;
  agentId: string;
  agentType: string;
  model: string;
  color?: string;
  planModeRequired?: boolean;
  joinedAt: number;
  tmuxPaneId: string;
  backendType?: string;
}

export interface TeamConfig {
  name: string;
  leadSessionId: string;
  members: TeamConfigMember[];
}

export interface TeammateInboxEntry {
  memberName: string;
  inboxPath: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamMessage {
  from: string;
  text: string;
  summary?: string;
  timestamp: string;
  color?: string;
  read?: boolean;
  /** True when `text` is valid JSON (e.g. idle_notification, task_assignment). */
  isStructured: boolean;
  structuredPayload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TeamInboxMonitor
// ---------------------------------------------------------------------------

/**
 * Monitors the Claude team leader inbox file for incoming agent messages.
 *
 * The inbox lives at: ~/.claude/teams/{teamName}/inboxes/team-lead.json
 * It is a JSON array appended to by Claude's team orchestration system.
 * New messages are detected by comparing the current array length with the
 * last known length — no timestamps or IDs are needed.
 */
export class TeamInboxMonitor {
  private inboxPath: string;
  private configPath: string;
  private inboxesDir: string;
  /** Count of messages seen at the last poll (or at startPolling time). */
  private lastCount = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-teammate message counts for outbox polling. */
  private outboxLastCounts: Map<string, number> = new Map();
  private outboxPollTimer: ReturnType<typeof setInterval> | null = null;
  /** The team name used for building paths. */
  private teamName: string;

  constructor(teamName: string) {
    this.teamName = teamName;
    const teamDir = join(homedir(), '.claude', 'teams', teamName);
    this.inboxPath = join(teamDir, 'inboxes', 'team-lead.json');
    this.configPath = join(teamDir, 'config.json');
    this.inboxesDir = join(teamDir, 'inboxes');
  }

  // ---------------------------------------------------------------------------
  // Static: discover team name for a session
  // ---------------------------------------------------------------------------

  /**
   * Search ~/.claude/teams/{name}/config.json for a config whose `leadSessionId`
   * matches the given session ID. Returns the team name (directory name) or
   * null if this session is not a team leader.
   *
   * Uses synchronous fs calls — safe to call from an async context.
   */
  static findTeamForSession(sessionId: string): string | null {
    const teamsDir = join(homedir(), '.claude', 'teams');
    if (!existsSync(teamsDir)) return null;

    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(teamsDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = join(teamsDir, entry.name, 'config.json');
      if (!existsSync(configPath)) continue;
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw) as Record<string, unknown>;
        if (config.leadSessionId === sessionId) {
          return entry.name;
        }
      } catch {
        // Malformed config — skip and continue scanning
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Read all messages currently in the inbox.
   * Returns an empty array if the file does not exist or cannot be parsed.
   */
  readAllMessages(): TeamMessage[] {
    if (!existsSync(this.inboxPath)) return [];
    try {
      const raw = readFileSync(this.inboxPath, 'utf-8');
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      return (arr as Array<Record<string, unknown>>).map((item) => this.parseRawMessage(item));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /**
   * Start polling the inbox every `intervalMs` milliseconds.
   * Calls `onMessage` for each new message that appears AFTER `startPolling`
   * was called. Pre-existing messages are NOT fired — use `readAllMessages()`
   * separately for backfill.
   *
   * No-op if polling is already active.
   */
  startPolling(intervalMs: number, onMessage: (msg: TeamMessage) => void): void {
    if (this.pollTimer !== null) return;

    // Snapshot current count so pre-existing messages are skipped.
    this.lastCount = this.readAllMessages().length;

    this.pollTimer = setInterval(() => {
      const messages = this.readAllMessages();
      if (messages.length > this.lastCount) {
        const newMessages = messages.slice(this.lastCount);
        this.lastCount = messages.length;
        for (const msg of newMessages) {
          onMessage(msg);
        }
      }
    }, intervalMs);
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  /**
   * Read the team config from config.json and return the structured config.
   * Returns null if the file does not exist or cannot be parsed.
   */
  readConfig(): TeamConfig | null {
    if (!existsSync(this.configPath)) return null;
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const members = Array.isArray(obj.members)
        ? (obj.members as Array<Record<string, unknown>>).map((m) => this.parseMember(m))
        : [];
      return {
        name: typeof obj.name === 'string' ? obj.name : this.teamName,
        leadSessionId: typeof obj.leadSessionId === 'string' ? obj.leadSessionId : '',
        members,
      };
    } catch {
      return null;
    }
  }

  /**
   * List all teammate inbox paths (excluding team-lead.json which is monitored separately).
   * Returns array of { memberName, inboxPath } entries.
   */
  listTeammateInboxPaths(): TeammateInboxEntry[] {
    if (!existsSync(this.inboxesDir)) return [];

    let entries: string[];
    try {
      entries = readdirSync(this.inboxesDir) as string[];
    } catch {
      return [];
    }

    const result: TeammateInboxEntry[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      if (!entry.endsWith('.json')) continue;
      if (entry === 'team-lead.json') continue;
      const memberName = entry.slice(0, -5); // strip .json
      result.push({
        memberName,
        inboxPath: join(this.inboxesDir, entry),
      });
    }
    return result;
  }

  /**
   * Read all outbox messages (lead → teammate) from all teammate inboxes.
   * Returns array of { toAgent, message } entries.
   */
  readAllOutboxMessages(): Array<{ toAgent: string; message: TeamMessage }> {
    const result: Array<{ toAgent: string; message: TeamMessage }> = [];
    for (const { memberName, inboxPath } of this.listTeammateInboxPaths()) {
      const msgs = this.readInboxFile(inboxPath);
      for (const msg of msgs) {
        result.push({ toAgent: memberName, message: msg });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Outbox polling (lead → teammate messages)
  // ---------------------------------------------------------------------------

  /**
   * Start polling all teammate inboxes every `intervalMs` milliseconds.
   * Calls `onMessage(toAgent, msg)` for each new message that appears.
   * Pre-existing messages are skipped (snapshot taken at start time).
   *
   * No-op if outbox polling is already active.
   */
  startOutboxPolling(
    intervalMs: number,
    onMessage: (toAgent: string, msg: TeamMessage) => void,
  ): void {
    if (this.outboxPollTimer !== null) return;

    // Snapshot current counts per inbox so pre-existing messages are skipped.
    for (const { memberName, inboxPath } of this.listTeammateInboxPaths()) {
      const msgs = this.readInboxFile(inboxPath);
      this.outboxLastCounts.set(memberName, msgs.length);
    }

    this.outboxPollTimer = setInterval(() => {
      for (const { memberName, inboxPath } of this.listTeammateInboxPaths()) {
        const msgs = this.readInboxFile(inboxPath);
        const lastCount = this.outboxLastCounts.get(memberName) ?? 0;
        if (msgs.length > lastCount) {
          const newMsgs = msgs.slice(lastCount);
          this.outboxLastCounts.set(memberName, msgs.length);
          for (const msg of newMsgs) {
            onMessage(memberName, msg);
          }
        }
      }
    }, intervalMs);
  }

  /**
   * Stop outbox polling. Safe to call multiple times or when not polling.
   */
  stopOutboxPolling(): void {
    if (this.outboxPollTimer !== null) {
      clearInterval(this.outboxPollTimer);
      this.outboxPollTimer = null;
    }
    this.outboxLastCounts.clear();
  }

  /**
   * Check if the team has been disbanded.
   * True when: config file is gone, OR all non-leader members sent shutdown_approved.
   */
  isTeamDisbanded(): boolean {
    if (!existsSync(this.configPath)) return true;

    try {
      const config = JSON.parse(readFileSync(this.configPath, 'utf-8')) as {
        members?: Array<{ name: string }>;
      };
      const nonLeaderMembers = (config.members ?? []).filter((m) => m.name !== 'team-lead');
      if (nonLeaderMembers.length === 0) return false; // no teammates yet

      const messages = this.readAllMessages();
      const shutdownApproved = new Set<string>();
      for (const msg of messages) {
        if (msg.isStructured && msg.structuredPayload?.type === 'shutdown_approved') {
          shutdownApproved.add(msg.from);
        }
      }

      return nonLeaderMembers.every((m) => shutdownApproved.has(m.name));
    } catch {
      return false;
    }
  }

  /**
   * Stop polling. Safe to call multiple times or when not polling.
   */
  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read messages from any inbox JSON file (generalized version of readAllMessages).
   */
  private readInboxFile(filePath: string): TeamMessage[] {
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      return (arr as Array<Record<string, unknown>>).map((item) => this.parseRawMessage(item));
    } catch {
      return [];
    }
  }

  private parseMember(m: Record<string, unknown>): TeamConfigMember {
    return {
      name: typeof m.name === 'string' ? m.name : '',
      agentId: typeof m.agentId === 'string' ? m.agentId : '',
      agentType: typeof m.agentType === 'string' ? m.agentType : '',
      model: typeof m.model === 'string' ? m.model : '',
      color: typeof m.color === 'string' ? m.color : undefined,
      planModeRequired: typeof m.planModeRequired === 'boolean' ? m.planModeRequired : undefined,
      joinedAt: typeof m.joinedAt === 'number' ? m.joinedAt : 0,
      tmuxPaneId: typeof m.tmuxPaneId === 'string' ? m.tmuxPaneId : '',
      backendType: typeof m.backendType === 'string' ? m.backendType : undefined,
    };
  }

  private parseRawMessage(item: Record<string, unknown>): TeamMessage {
    const text = typeof item.text === 'string' ? item.text : '';
    let isStructured = false;
    let structuredPayload: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null) {
        isStructured = true;
        structuredPayload = parsed;
      }
    } catch {
      // Plain markdown — not structured
    }
    return {
      from: typeof item.from === 'string' ? item.from : '',
      text,
      summary: typeof item.summary === 'string' ? item.summary : undefined,
      timestamp: typeof item.timestamp === 'string' ? item.timestamp : '',
      color: typeof item.color === 'string' ? item.color : undefined,
      read: typeof item.read === 'boolean' ? item.read : undefined,
      isStructured,
      structuredPayload,
    };
  }
}
