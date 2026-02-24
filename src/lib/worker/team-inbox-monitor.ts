import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

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
  /** Count of messages seen at the last poll (or at startPolling time). */
  private lastCount = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(teamName: string) {
    this.inboxPath = join(homedir(), '.claude', 'teams', teamName, 'inboxes', 'team-lead.json');
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
