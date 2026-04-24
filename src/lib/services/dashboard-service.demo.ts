/**
 * Demo-mode shadow for dashboard-service.
 *
 * Exports deterministic fixture data and re-implements every public function
 * from dashboard-service.ts without touching the database.
 */

import type {
  DashboardStats,
  RecentEvent,
  AgentHealthEntry,
} from '@/lib/services/dashboard-service';

// ---------------------------------------------------------------------------
// Canonical demo UUIDs (hardcoded to avoid cross-agent import coupling)
// ---------------------------------------------------------------------------

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';
const GEMINI_AGENT_ID = '33333333-3333-4333-a333-333333333333';

// Task UUID prefix — matches Agent A's canonical fixtures
const T_PREFIX = 'aaaaaaaa-aaaa-4';

// ---------------------------------------------------------------------------
// Fixed timestamps — deterministic across renders
// ---------------------------------------------------------------------------

const T_NOW = new Date('2026-04-23T10:00:00.000Z');
const T_23H_AGO = new Date('2026-04-22T11:00:00.000Z');
const T_20H_AGO = new Date('2026-04-22T14:00:00.000Z');
const T_18H_AGO = new Date('2026-04-22T16:00:00.000Z');
const T_15H_AGO = new Date('2026-04-22T19:00:00.000Z');
const T_12H_AGO = new Date('2026-04-22T22:00:00.000Z');
const T_8H_AGO = new Date('2026-04-23T02:00:00.000Z');
const T_4H_AGO = new Date('2026-04-23T06:00:00.000Z');
const T_1H_AGO = new Date('2026-04-23T09:00:00.000Z');

// ---------------------------------------------------------------------------
// Fixture: task status counts (matches Agent A's 15-task fixture narrative)
// ---------------------------------------------------------------------------

const DEMO_TASK_COUNTS_BY_STATUS: Record<string, number> = {
  todo: 5,
  in_progress: 3,
  blocked: 2,
  done: 4,
  cancelled: 1,
};

// ---------------------------------------------------------------------------
// Fixture: agent health
// ---------------------------------------------------------------------------

const DEMO_AGENT_HEALTH: AgentHealthEntry[] = [
  {
    id: CLAUDE_AGENT_ID,
    name: 'Claude Code',
    slug: 'claude-code',
    isActive: true,
    maxConcurrent: 3,
  },
  {
    id: CODEX_AGENT_ID,
    name: 'Codex CLI',
    slug: 'codex-cli',
    isActive: true,
    maxConcurrent: 2,
  },
  {
    id: GEMINI_AGENT_ID,
    name: 'Gemini CLI',
    slug: 'gemini-cli',
    isActive: false, // auth-required simulation
    maxConcurrent: 2,
  },
];

// ---------------------------------------------------------------------------
// Fixture: recent task events (deterministic, referencing canonical task IDs)
// ---------------------------------------------------------------------------

const DEMO_RECENT_EVENTS: RecentEvent[] = [
  {
    id: 1,
    taskId: `${T_PREFIX}001-a001-aaaaaaaaaaaa`,
    eventType: 'status_changed',
    actorType: 'agent',
    payload: { from: 'todo', to: 'in_progress', agentId: CLAUDE_AGENT_ID },
    createdAt: T_1H_AGO,
  },
  {
    id: 2,
    taskId: `${T_PREFIX}003-a003-aaaaaaaaaaaa`,
    eventType: 'status_changed',
    actorType: 'agent',
    payload: { from: 'in_progress', to: 'done', agentId: CLAUDE_AGENT_ID },
    createdAt: T_4H_AGO,
  },
  {
    id: 3,
    taskId: `${T_PREFIX}004-a004-aaaaaaaaaaaa`,
    eventType: 'progress_note',
    actorType: 'agent',
    payload: { note: 'Analyzed codebase structure. 3 modules need refactoring.' },
    createdAt: T_8H_AGO,
  },
  {
    id: 4,
    taskId: `${T_PREFIX}005-a005-aaaaaaaaaaaa`,
    eventType: 'status_changed',
    actorType: 'agent',
    payload: { from: 'todo', to: 'in_progress', agentId: CODEX_AGENT_ID },
    createdAt: T_12H_AGO,
  },
  {
    id: 5,
    taskId: `${T_PREFIX}006-a006-aaaaaaaaaaaa`,
    eventType: 'status_changed',
    actorType: 'agent',
    payload: { from: 'in_progress', to: 'blocked', agentId: GEMINI_AGENT_ID },
    createdAt: T_15H_AGO,
  },
  {
    id: 6,
    taskId: `${T_PREFIX}007-a007-aaaaaaaaaaaa`,
    eventType: 'status_changed',
    actorType: 'user',
    payload: { from: 'blocked', to: 'todo', note: 'Dependency resolved' },
    createdAt: T_18H_AGO,
  },
  {
    id: 7,
    taskId: `${T_PREFIX}008-a008-aaaaaaaaaaaa`,
    eventType: 'progress_note',
    actorType: 'agent',
    payload: { note: 'Draft implementation complete, pending review.' },
    createdAt: T_20H_AGO,
  },
  {
    id: 8,
    taskId: `${T_PREFIX}009-a009-aaaaaaaaaaaa`,
    eventType: 'status_changed',
    actorType: 'agent',
    payload: { from: 'in_progress', to: 'done', agentId: CODEX_AGENT_ID },
    createdAt: T_23H_AGO,
  },
];

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function getDashboardStats(): Promise<DashboardStats> {
  return {
    taskCountsByStatus: DEMO_TASK_COUNTS_BY_STATUS,
    totalTasks: 15,
    projectCount: 3,
    recentEvents: DEMO_RECENT_EVENTS,
    agentHealth: DEMO_AGENT_HEALTH,
    workerStatus: {
      isOnline: true,
      lastSeenAt: T_NOW,
    },
  };
}
