/**
 * Demo-mode shadow for session-service.
 *
 * Exports fixture data and re-implements every public function from
 * session-service.ts without touching the database. All mutations are no-ops
 * that return believable stubs.
 */

import { randomUUID } from 'node:crypto';
import { NotFoundError } from '@/lib/errors';
import type { Session } from '@/lib/types';
import type {
  SessionWithDetails,
  SessionListItem,
  SearchSessionResult,
  SessionSummary,
  CreateSessionInput,
} from '@/lib/services/session-service';

// ---------------------------------------------------------------------------
// Canonical demo UUIDs (shared across all agents in the demo mode feature)
// ---------------------------------------------------------------------------

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';
const GEMINI_AGENT_ID = '33333333-3333-4333-a333-333333333333';

const AGENDO_PROJECT_ID = '44444444-4444-4444-a444-444444444444';
const OTHER_APP_PROJECT_ID = '55555555-5555-4555-a555-555555555555';

export const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';
export const CODEX_SESSION_ID = '88888888-8888-4888-a888-888888888888';
export const GEMINI_SESSION_ID = '99999999-9999-4999-a999-999999999999';

// ---------------------------------------------------------------------------
// Fixed timestamps — deterministic across renders
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-23T10:00:00.000Z');
const T_72H_AGO = new Date('2026-04-20T10:00:00.000Z');
const T_48H_AGO = new Date('2026-04-21T10:00:00.000Z');
const T_24H_AGO = new Date('2026-04-22T10:00:00.000Z');
const T_22H_AGO = new Date('2026-04-22T12:00:00.000Z');
const T_20H_AGO = new Date('2026-04-22T14:00:00.000Z');

// ---------------------------------------------------------------------------
// Fixtures — must satisfy typeof sessions.$inferSelect
// ---------------------------------------------------------------------------

export const DEMO_SESSION_CLAUDE_EXPLORE: Session = {
  id: CLAUDE_SESSION_ID,
  taskId: null,
  projectId: AGENDO_PROJECT_ID,
  kind: 'conversation',
  agentId: CLAUDE_AGENT_ID,
  status: 'active',
  pid: null,
  workerId: 'demo-worker-1',
  sessionRef: 'claude-demo-session-ref-abc123',
  eventSeq: 47,
  heartbeatAt: new Date('2026-04-23T09:58:00.000Z'),
  startedAt: T_72H_AGO,
  lastActiveAt: new Date('2026-04-23T09:58:00.000Z'),
  idleTimeoutSec: 600,
  endedAt: null,
  logFilePath: '/data/agendo/logs/77777777.jsonl',
  totalCostUsd: '0.342800',
  totalTurns: 12,
  permissionMode: 'bypassPermissions',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
  initialPrompt: 'Exploring the codebase to understand how session reconnect handles SSE catchup.',
  title: 'Exploring session reconnect + SSE catchup',
  model: 'claude-opus-4-5-20250514',
  effort: 'medium',
  webSearchRequests: 0,
  webFetchRequests: 0,
  planFilePath: null,
  autoResumeCount: 0,
  totalDurationMs: null,
  tmuxSessionName: null,
  parentSessionId: null,
  forkSourceRef: null,
  forkPointUuid: null,
  mcpServerIds: null,
  delegationPolicy: 'suggest',
  teamRole: null,
  useWorktree: false,
  maxBudgetUsd: null,
  createdAt: T_72H_AGO,
};

export const DEMO_SESSION_CODEX_REFACTOR: Session = {
  id: CODEX_SESSION_ID,
  taskId: null,
  projectId: AGENDO_PROJECT_ID,
  kind: 'conversation',
  agentId: CODEX_AGENT_ID,
  status: 'ended',
  pid: null,
  workerId: null,
  sessionRef: null,
  eventSeq: 31,
  heartbeatAt: null,
  startedAt: T_48H_AGO,
  lastActiveAt: T_24H_AGO,
  idleTimeoutSec: 600,
  endedAt: T_24H_AGO,
  logFilePath: '/data/agendo/logs/88888888.jsonl',
  totalCostUsd: '0.187400',
  totalTurns: 8,
  permissionMode: 'acceptEdits',
  allowedTools: [],
  initialPrompt: 'Refactored session reconnect to use lastEventId for SSE catchup. Tests green.',
  title: 'Refactor: SSE reconnect with lastEventId',
  model: 'codex-1',
  effort: null,
  webSearchRequests: 0,
  webFetchRequests: 0,
  planFilePath: null,
  autoResumeCount: 0,
  totalDurationMs: 4320000,
  tmuxSessionName: null,
  parentSessionId: null,
  forkSourceRef: null,
  forkPointUuid: null,
  mcpServerIds: null,
  delegationPolicy: 'suggest',
  teamRole: null,
  useWorktree: false,
  maxBudgetUsd: null,
  createdAt: T_48H_AGO,
};

export const DEMO_SESSION_GEMINI_PLAN: Session = {
  id: GEMINI_SESSION_ID,
  taskId: null,
  projectId: OTHER_APP_PROJECT_ID,
  kind: 'conversation',
  agentId: GEMINI_AGENT_ID,
  status: 'awaiting_input',
  pid: null,
  workerId: null,
  sessionRef: null,
  eventSeq: 9,
  heartbeatAt: T_20H_AGO,
  startedAt: T_22H_AGO,
  lastActiveAt: T_20H_AGO,
  idleTimeoutSec: 600,
  endedAt: null,
  logFilePath: '/data/agendo/logs/99999999.jsonl',
  totalCostUsd: '0.064200',
  totalTurns: 3,
  permissionMode: 'default',
  allowedTools: [],
  initialPrompt: 'Awaiting user approval for file write to my-other-app/src/features.md.',
  title: 'Plan: awaiting approval to write features.md',
  model: 'gemini-2.5-pro',
  effort: null,
  webSearchRequests: 0,
  webFetchRequests: 0,
  planFilePath: null,
  autoResumeCount: 0,
  totalDurationMs: null,
  tmuxSessionName: null,
  parentSessionId: null,
  forkSourceRef: null,
  forkPointUuid: null,
  mcpServerIds: null,
  delegationPolicy: 'suggest',
  teamRole: null,
  useWorktree: false,
  maxBudgetUsd: null,
  createdAt: T_22H_AGO,
};

const ALL_SESSIONS: Session[] = [
  DEMO_SESSION_CLAUDE_EXPLORE,
  DEMO_SESSION_CODEX_REFACTOR,
  DEMO_SESSION_GEMINI_PLAN,
];

// ---------------------------------------------------------------------------
// Enrichment metadata (mirrors what DB joins would return)
// ---------------------------------------------------------------------------

const AGENT_NAMES: Record<string, string> = {
  [CLAUDE_AGENT_ID]: 'Claude Code',
  [CODEX_AGENT_ID]: 'Codex CLI',
  [GEMINI_AGENT_ID]: 'Gemini CLI',
};

const AGENT_SLUGS: Record<string, string> = {
  [CLAUDE_AGENT_ID]: 'claude-code',
  [CODEX_AGENT_ID]: 'codex-cli',
  [GEMINI_AGENT_ID]: 'gemini-cli',
};

const PROJECT_NAMES: Record<string, string> = {
  [AGENDO_PROJECT_ID]: 'agendo',
  [OTHER_APP_PROJECT_ID]: 'my-other-app',
};

const PROJECT_ROOT_PATHS: Record<string, string> = {
  [AGENDO_PROJECT_ID]: '/home/ubuntu/projects/agendo',
  [OTHER_APP_PROJECT_ID]: '/home/ubuntu/projects/my-other-app',
};

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export function getSession(id: string): Session {
  const session = ALL_SESSIONS.find((s) => s.id === id);
  if (!session) throw new NotFoundError('Session', id);
  return session;
}

export function getSessionWithDetails(id: string): SessionWithDetails {
  const session = getSession(id); // throws if not found
  return {
    ...session,
    agentName: AGENT_NAMES[session.agentId] ?? null,
    agentSlug: AGENT_SLUGS[session.agentId] ?? null,
    taskTitle: null,
    projectName: session.projectId ? (PROJECT_NAMES[session.projectId] ?? null) : null,
    projectRootPath: session.projectId ? (PROJECT_ROOT_PATHS[session.projectId] ?? null) : null,
  };
}

export function getSessionLogInfo(
  id: string,
): { logFilePath: string | null; status: string } | null {
  const session = ALL_SESSIONS.find((s) => s.id === id);
  if (!session) return null;
  return { logFilePath: session.logFilePath, status: session.status };
}

export function getSessionStatus(id: string): { status: string } | null {
  const session = ALL_SESSIONS.find((s) => s.id === id);
  if (!session) return null;
  return { status: session.status };
}

export function listSessions(filters?: {
  taskId?: string;
  agentId?: string;
  status?: string;
  kind?: string;
  page?: number;
  pageSize?: number;
}): {
  data: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
} {
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 20;

  let filtered = ALL_SESSIONS;

  if (filters?.agentId) {
    filtered = filtered.filter((s) => s.agentId === filters.agentId);
  }
  if (filters?.status) {
    filtered = filtered.filter((s) => s.status === filters.status);
  }
  if (filters?.taskId) {
    filtered = filtered.filter((s) => s.taskId === filters.taskId);
  }
  if (filters?.kind) {
    filtered = filtered.filter((s) => s.kind === filters.kind);
  }

  const total = filtered.length;
  // Apply simple pagination
  const offset = (page - 1) * pageSize;
  const paginated = filtered.slice(offset, offset + pageSize);

  const data: SessionSummary[] = paginated.map((s) => ({
    id: s.id,
    status: s.status,
    kind: s.kind,
    title: s.title,
    agentId: s.agentId,
    agentName: AGENT_NAMES[s.agentId] ?? null,
    taskId: s.taskId,
    taskTitle: null,
    projectId: s.projectId,
    permissionMode: s.permissionMode,
    model: s.model,
    createdAt: s.createdAt,
  }));

  return { data, total, page, pageSize };
}

export function listSessionsByProject(
  projectId: string,
  _filter: 'free-chats' | 'task-sessions',
  limit = 20,
): SessionListItem[] {
  const filtered = ALL_SESSIONS.filter((s) => s.projectId === projectId).slice(0, limit);
  return filtered.map((s) => ({
    id: s.id,
    status: s.status,
    title: s.title,
    initialPrompt: s.initialPrompt ? s.initialPrompt.substring(0, 80) : null,
    agentName: AGENT_NAMES[s.agentId] ?? 'Unknown',
    taskTitle: null,
    createdAt: s.createdAt,
  }));
}

export function searchSessions(q: string, limit = 5): SearchSessionResult[] {
  if (!q.trim()) return [];
  const lower = q.toLowerCase();
  const matched = ALL_SESSIONS.filter(
    (s) => s.title?.toLowerCase().includes(lower) || s.initialPrompt?.toLowerCase().includes(lower),
  );
  return matched.slice(0, limit).map((s) => ({
    id: s.id,
    title: s.title ?? s.initialPrompt?.substring(0, 80) ?? 'Untitled session',
    status: s.status,
    agentName: AGENT_NAMES[s.agentId] ?? 'Unknown',
  }));
}

// ---------------------------------------------------------------------------
// Mutation stubs — no side effects
// ---------------------------------------------------------------------------

/** Returns a believable idle session without touching the DB. */
export function createSession(input: CreateSessionInput): Session {
  return {
    id: 'demo-stub-' + Date.now(),
    taskId: input.taskId ?? null,
    projectId: input.projectId ?? null,
    kind: input.kind ?? 'conversation',
    agentId: input.agentId,
    status: 'idle',
    pid: null,
    workerId: null,
    sessionRef: null,
    eventSeq: 0,
    heartbeatAt: null,
    startedAt: null,
    lastActiveAt: null,
    idleTimeoutSec: input.idleTimeoutSec ?? 600,
    endedAt: null,
    logFilePath: null,
    totalCostUsd: null,
    totalTurns: 0,
    permissionMode: input.permissionMode ?? 'bypassPermissions',
    allowedTools: input.allowedTools ?? [],
    initialPrompt: input.initialPrompt ?? null,
    title: null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    webSearchRequests: 0,
    webFetchRequests: 0,
    planFilePath: null,
    autoResumeCount: 0,
    totalDurationMs: null,
    tmuxSessionName: null,
    parentSessionId: input.parentSessionId ?? null,
    forkSourceRef: null,
    forkPointUuid: null,
    mcpServerIds: input.mcpServerIds ?? null,
    delegationPolicy: input.delegationPolicy ?? 'suggest',
    teamRole: input.teamRole ?? null,
    useWorktree: input.useWorktree ?? false,
    maxBudgetUsd: input.maxBudgetUsd != null ? String(input.maxBudgetUsd) : null,
    createdAt: NOW,
  };
}

/** No-op cancel in demo mode. */
export function cancelSession(_id: string): void {
  // No side effects
}

/** No-op delete in demo mode. */
export function deleteSession(_id: string): void {
  // No side effects
}

/** No-op bulk delete in demo mode. */
export function deleteSessions(_ids: string[]): { deletedCount: number; skippedIds: string[] } {
  return { deletedCount: 0, skippedIds: [] };
}

/** No-op interrupt in demo mode. */
export function interruptSession(_id: string): void {
  // No side effects
}

/** No-op title update in demo mode. */
export function updateSessionTitle(
  id: string,
  title: string | null,
): { id: string; title: string | null } {
  return { id, title };
}

/**
 * Synthesizes a fork of the parent session without touching the DB.
 * Assigns a new UUID for the fork id and stores the parent's sessionRef as
 * forkSourceRef (matching real function behavior: fork resumes parent history).
 */
export function forkSession(parentId: string, resumeAt?: string, initialPrompt?: string): Session {
  const parent = getSession(parentId); // throws NotFoundError if not found
  return {
    ...parent,
    id: randomUUID(),
    status: 'idle',
    pid: null,
    workerId: null,
    sessionRef: null,
    eventSeq: 0,
    heartbeatAt: null,
    startedAt: null,
    lastActiveAt: null,
    endedAt: null,
    logFilePath: null,
    totalCostUsd: null,
    totalTurns: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    autoResumeCount: 0,
    totalDurationMs: null,
    tmuxSessionName: null,
    parentSessionId: parentId,
    forkSourceRef: parent.sessionRef,
    forkPointUuid: resumeAt ?? null,
    initialPrompt: initialPrompt ?? null,
    createdAt: new Date(),
  } satisfies Session;
}

/**
 * Synthesizes a fresh child session for plan implementation without touching the DB.
 * Unlike forkSession, no forkSourceRef is set — the child starts with a blank slate
 * (no --resume). The initialPrompt is built from planContent, matching real behavior.
 */
export function restartFreshFromSession(
  parentId: string,
  planContent: string | null,
  permissionMode: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk',
): Session {
  const parent = getSession(parentId); // throws NotFoundError if not found
  const sessionInitialPrompt = planContent
    ? `Implement the following plan:\n\n${planContent}`
    : 'Continue implementing the plan from the previous conversation.';

  return {
    ...parent,
    id: randomUUID(),
    kind: 'conversation',
    status: 'idle',
    pid: null,
    workerId: null,
    sessionRef: null,
    eventSeq: 0,
    heartbeatAt: null,
    startedAt: null,
    lastActiveAt: null,
    endedAt: null,
    logFilePath: null,
    totalCostUsd: null,
    totalTurns: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    autoResumeCount: 0,
    totalDurationMs: null,
    tmuxSessionName: null,
    parentSessionId: parentId,
    forkSourceRef: null,
    forkPointUuid: null,
    permissionMode,
    initialPrompt: sessionInitialPrompt,
    createdAt: new Date(),
  } satisfies Session;
}

/**
 * @deprecated Use listSessionsByProject(projectId, 'free-chats', limit)
 * Returns sessions with no taskId for the given project.
 */
export function listFreeChatsByProject(projectId: string, limit = 20): SessionListItem[] {
  return listSessionsByProject(projectId, 'free-chats', limit).filter(
    (_item, _idx, arr) => arr.length <= limit,
  );
}

/**
 * @deprecated Use listSessionsByProject(projectId, 'task-sessions', limit)
 * Returns sessions that are linked to a task for the given project.
 */
export function listTaskSessionsByProject(projectId: string, limit = 20): SessionListItem[] {
  return listSessionsByProject(projectId, 'task-sessions', limit).filter(
    (_item, _idx, arr) => arr.length <= limit,
  );
}
