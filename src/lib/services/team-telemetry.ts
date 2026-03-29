/**
 * Team Telemetry — tracks team creation, messaging, and usage patterns.
 *
 * Logs events to a local JSONL file (LOG_DIR/team-telemetry.jsonl).
 * No sensitive content is logged — only structural metadata (counts, modes, directions).
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '@/lib/logger';

const log = createLogger('team-telemetry');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamCreationEvent {
  /** How the team was created */
  source: 'mcp' | 'ui';
  /** Creation mode */
  mode: 'agent_led' | 'ui_led';
  /** Parent task ID */
  parentTaskId: string;
  /** Number of team members */
  memberCount: number;
  /** Whether a lead session was attached */
  hasLeadSession: boolean;
}

export interface TeamMessageEvent {
  /** Parent task (team) ID */
  parentTaskId: string;
  /** Sender session */
  senderSessionId: string;
  /** Recipient session */
  recipientSessionId: string;
  /** Message direction */
  direction: 'lead_to_member' | 'member_to_lead' | 'member_to_member';
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function getLogPath(): string {
  const logDir = process.env.LOG_DIR ?? './logs';
  return `${logDir}/team-telemetry.jsonl`;
}

function appendEvent(event: Record<string, unknown>): void {
  try {
    const filePath = getLogPath();
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(event) + '\n');
  } catch (err) {
    log.warn({ err }, 'Failed to write team telemetry event');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function trackTeamCreation(event: TeamCreationEvent): void {
  appendEvent({
    type: 'team_created',
    ts: new Date().toISOString(),
    source: event.source,
    mode: event.mode,
    parentTaskId: event.parentTaskId,
    memberCount: event.memberCount,
    hasLeadSession: event.hasLeadSession,
  });

  log.info(
    {
      source: event.source,
      mode: event.mode,
      memberCount: event.memberCount,
      hasLeadSession: event.hasLeadSession,
    },
    'Team creation tracked',
  );
}

export function trackTeamMessage(event: TeamMessageEvent): void {
  appendEvent({
    type: 'team_message',
    ts: new Date().toISOString(),
    parentTaskId: event.parentTaskId,
    senderSessionId: event.senderSessionId,
    recipientSessionId: event.recipientSessionId,
    direction: event.direction,
  });
}
