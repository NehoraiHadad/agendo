import { eq, and, desc, count, or, ilike, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { buildFilters } from '@/lib/db/filter-builder';
import { db } from '@/lib/db';
import { sessions, agents, tasks, projects } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import { getById } from '@/lib/services/db-helpers';
import { ConflictError } from '@/lib/errors';
import { safeUnlinkMany } from '@/lib/utils/fs-utils';
import { sendSessionControl, sendSessionEvent } from '@/lib/realtime/worker-client';
import { dispatchSession } from '@/lib/services/session-dispatch';
import type { Session } from '@/lib/types';
import type { AgendoControl } from '@/lib/realtime/events';
import { isDemoMode } from '@/lib/demo/flag';

export type SessionKind = 'conversation' | 'execution' | 'plan' | 'integration' | 'support';

export interface CreateSessionInput {
  taskId?: string;
  projectId?: string;
  kind?: SessionKind;
  agentId: string;
  idleTimeoutSec?: number;
  initialPrompt?: string;
  permissionMode?: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';
  allowedTools?: string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  parentSessionId?: string;
  mcpServerIds?: string[];
  useWorktree?: boolean;
  /** Maximum API spend in USD for this session (Claude SDK only). Agent stops when exceeded. */
  maxBudgetUsd?: number;
  /** Controls team tool visibility in preambles. Default: 'forbid'. */
  delegationPolicy?: 'forbid' | 'suggest' | 'allow' | 'auto';
  /** Team role for this session. 'lead' = orchestrator, 'member' = team worker. */
  teamRole?: 'lead' | 'member';
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.createSession(input);
  }
  let projectId = input.projectId;

  // For execution sessions, derive projectId from task if not explicit
  if (!projectId && input.taskId) {
    const [task] = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    projectId = task?.projectId ?? undefined;
  }

  const [session] = await db
    .insert(sessions)
    .values({
      taskId: input.taskId ?? null,
      projectId: projectId ?? null,
      kind: input.kind ?? 'conversation',
      agentId: input.agentId,
      idleTimeoutSec: input.idleTimeoutSec ?? 600,
      status: 'idle', // session starts idle, goes active when worker claims it
      initialPrompt: input.initialPrompt,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.mcpServerIds ? { mcpServerIds: input.mcpServerIds } : {}),
      ...(input.useWorktree != null ? { useWorktree: input.useWorktree } : {}),
      ...(input.maxBudgetUsd != null ? { maxBudgetUsd: String(input.maxBudgetUsd) } : {}),
      ...(input.delegationPolicy ? { delegationPolicy: input.delegationPolicy } : {}),
      ...(input.teamRole ? { teamRole: input.teamRole } : {}),
    })
    .returning();
  return session;
}

export async function getSession(id: string): Promise<Session> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.getSession(id);
  }
  return getById(sessions, id, 'Session');
}

export interface SessionWithDetails extends Session {
  agentName: string | null;
  agentSlug: string | null;
  taskTitle: string | null;
  projectName: string | null;
  projectRootPath: string | null;
}

export async function getSessionWithDetails(id: string): Promise<SessionWithDetails> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.getSessionWithDetails(id);
  }
  const [row] = await db
    .select({
      session: sessions,
      agentName: agents.name,
      agentSlug: agents.slug,
      taskTitle: tasks.title,
      projectName: projects.name,
      projectRootPath: projects.rootPath,
    })
    .from(sessions)
    .leftJoin(agents, eq(sessions.agentId, agents.id))
    .leftJoin(tasks, eq(sessions.taskId, tasks.id))
    .leftJoin(projects, eq(projects.id, sessions.projectId))
    .where(eq(sessions.id, id))
    .limit(1);

  requireFound(row, 'Session', id);

  return {
    ...row.session,
    agentName: row.agentName,
    agentSlug: row.agentSlug,
    taskTitle: row.taskTitle,
    projectName: row.projectName,
    projectRootPath: row.projectRootPath,
  };
}

export async function updateSessionTitle(
  id: string,
  title: string | null,
): Promise<{ id: string; title: string | null }> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.updateSessionTitle(id, title);
  }
  const [updated] = await db
    .update(sessions)
    .set({ title })
    .where(eq(sessions.id, id))
    .returning({ id: sessions.id, title: sessions.title });

  requireFound(updated, 'Session', id);
  return updated;
}

export async function cancelSession(id: string): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.cancelSession(id);
  }
  const result = await db
    .update(sessions)
    .set({ status: 'ended', endedAt: new Date() })
    .where(and(eq(sessions.id, id), inArray(sessions.status, ['active', 'awaiting_input'])))
    .returning({ id: sessions.id });

  if (result.length === 0) {
    throw new ConflictError('Session not active or already ended');
  }

  // Notify SSE subscribers of the status change so the UI updates immediately,
  // even before the worker processes the cancel control message.
  await sendSessionEvent(id, { type: 'session:state', status: 'ended' });

  const control: AgendoControl = { type: 'cancel' };
  await sendSessionControl(id, control);
}

export async function interruptSession(id: string): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.interruptSession(id);
  }
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.status, 'active')))
    .limit(1);

  if (!session) {
    throw new ConflictError('Session not active');
  }

  const control: AgendoControl = { type: 'interrupt' };
  await sendSessionControl(id, control);
}

export async function getSessionLogInfo(
  id: string,
): Promise<{ logFilePath: string | null; status: string } | null> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.getSessionLogInfo(id);
  }
  const [row] = await db
    .select({ logFilePath: sessions.logFilePath, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return row ?? null;
}

export async function getSessionStatus(id: string): Promise<{ status: string } | null> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.getSessionStatus(id);
  }
  const [row] = await db
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return row ?? null;
}

/** Create a fork of an existing session.
 *
 * If the parent has a sessionRef (i.e. it has run at least one turn), the fork stores
 * forkSourceRef so that when the fork is first started it uses --resume <forkSourceRef>
 * --fork-session, giving it the full conversation history of the parent as its starting
 * point. Claude then issues a new sessionId for the fork via system:init.
 *
 * If the parent has no sessionRef, forkSourceRef is null and the fork starts fresh.
 *
 * @param resumeAt - Claude JSONL UUID of the assistant turn to branch from. Passed as
 *   --resume-session-at to Claude, truncating conversation history at that point.
 * @param initialPrompt - The user's (possibly edited) message to kick off the branch.
 *   When provided, the fork is enqueued immediately without waiting for user to send
 *   the first message.
 */
export async function forkSession(
  parentId: string,
  resumeAt?: string,
  initialPrompt?: string,
): Promise<Session> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.forkSession(parentId, resumeAt, initialPrompt);
  }
  const parent = await getSession(parentId);
  const [fork] = await db
    .insert(sessions)
    .values({
      taskId: parent.taskId,
      projectId: parent.projectId,
      kind: parent.kind,
      agentId: parent.agentId,
      idleTimeoutSec: parent.idleTimeoutSec,
      status: 'idle',
      permissionMode: parent.permissionMode as
        | 'default'
        | 'bypassPermissions'
        | 'acceptEdits'
        | 'plan'
        | 'dontAsk',
      allowedTools: parent.allowedTools as string[],
      ...(parent.model ? { model: parent.model } : {}),
      ...(initialPrompt ? { initialPrompt } : {}),
      parentSessionId: parentId,
      // Store the parent's Claude session ID so the first start can use --fork-session.
      // Always set when the parent has a sessionRef so both the bare "Fork" toolbar button
      // (no resumeAt) and the "Edit message" button (with resumeAt) both resume the parent
      // history and create a proper fork rather than starting a blank session.
      forkSourceRef: parent.sessionRef ?? null,
      // Store the fork point so the UI can truncate parent history at this message.
      forkPointUuid: resumeAt ?? null,
    })
    .returning();

  // Enqueue immediately when the parent has a sessionRef and an initialPrompt is
  // provided. This starts the fork right away without waiting for the user to
  // send the first message manually.
  if (parent.sessionRef && initialPrompt) {
    await dispatchSession({
      sessionId: fork.id,
      resumeSessionAt: resumeAt,
      resumePrompt: initialPrompt,
    });
  }

  return fork;
}

/**
 * Create a fresh child session for plan implementation.
 *
 * Unlike forkSession(), this does NOT carry over the parent's sessionRef —
 * the child starts with a blank slate (no --resume) so Claude has no memory
 * of the plan mode conversation. Used by the "Restart fresh" ExitPlanMode action.
 *
 * The caller is responsible for calling dispatchSession() when the time is right
 * (immediately for idle parents; from the worker's onExit for active parents).
 */
export async function restartFreshFromSession(
  parentId: string,
  planContent: string | null,
  permissionMode: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk',
): Promise<Session> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.restartFreshFromSession(parentId, planContent, permissionMode);
  }
  const parent = await getSession(parentId);
  const initialPrompt = planContent
    ? `Implement the following plan:\n\n${planContent}`
    : 'Continue implementing the plan from the previous conversation.';

  const [newSession] = await db
    .insert(sessions)
    .values({
      taskId: parent.taskId,
      projectId: parent.projectId,
      kind: 'conversation',
      agentId: parent.agentId,
      idleTimeoutSec: parent.idleTimeoutSec,
      status: 'idle',
      permissionMode,
      allowedTools: parent.allowedTools as string[],
      ...(parent.model ? { model: parent.model } : {}),
      initialPrompt,
      parentSessionId: parentId,
      // No forkSourceRef — fresh conversation, no --resume
    })
    .returning();

  return newSession;
}

export interface SessionWithAgent extends Session {
  agentName: string;
  taskTitle: string | null;
}

/** Lightweight projection for listing sessions — avoids fetching multi-MB initial_prompt blobs. */
export interface SessionListItem {
  id: string;
  status: string;
  title: string | null;
  initialPrompt: string | null;
  agentName: string;
  taskTitle: string | null;
  createdAt: Date;
}

export async function listSessionsByProject(
  projectId: string,
  filter: 'free-chats' | 'task-sessions',
  limit = 20,
): Promise<SessionListItem[]> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.listSessionsByProject(projectId, filter, limit);
  }
  const taskFilter = filter === 'free-chats' ? isNull(sessions.taskId) : isNotNull(sessions.taskId);
  const rows = await db
    .select({
      id: sessions.id,
      status: sessions.status,
      title: sessions.title,
      initialPrompt: sql<string | null>`left(${sessions.initialPrompt}, 80)`,
      agentName: agents.name,
      taskTitle: tasks.title,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .leftJoin(tasks, eq(sessions.taskId, tasks.id))
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(and(eq(sessions.projectId, projectId), taskFilter))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
  return rows;
}

/** @deprecated Use listSessionsByProject(projectId, 'free-chats', limit) */
export async function listFreeChatsByProject(
  projectId: string,
  limit = 20,
): Promise<SessionListItem[]> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.listFreeChatsByProject(projectId, limit);
  }
  return listSessionsByProject(projectId, 'free-chats', limit);
}

/** @deprecated Use listSessionsByProject(projectId, 'task-sessions', limit) */
export async function listTaskSessionsByProject(
  projectId: string,
  limit = 20,
): Promise<SessionListItem[]> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.listTaskSessionsByProject(projectId, limit);
  }
  return listSessionsByProject(projectId, 'task-sessions', limit);
}

export interface SearchSessionResult {
  id: string;
  title: string;
  status: string;
  agentName: string;
}

export async function searchSessions(q: string, limit = 5): Promise<SearchSessionResult[]> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.searchSessions(q, limit);
  }
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      // Truncate to 80 chars — used as display fallback only, not full content needed
      initialPromptPreview: sql<string | null>`left(${sessions.initialPrompt}, 80)`,
      status: sessions.status,
      agentName: agents.name,
    })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(or(ilike(sessions.title, `%${q}%`), ilike(sessions.initialPrompt, `%${q}%`)))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? row.initialPromptPreview ?? 'Untitled session',
    status: row.status,
    agentName: row.agentName,
  }));
}

export interface ListSessionsInput {
  taskId?: string;
  agentId?: string;
  status?: string;
  kind?: SessionKind;
  page?: number;
  pageSize?: number;
}

/** Lightweight projection for the sessions list API — avoids fetching large text columns. */
export interface SessionSummary {
  id: string;
  status: string;
  kind: string;
  title: string | null;
  agentId: string;
  agentName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  permissionMode: string | null;
  model: string | null;
  createdAt: Date;
}

export async function listSessions(filters?: ListSessionsInput): Promise<{
  data: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.listSessions(filters);
  }
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const where = buildFilters(
    {
      taskId: filters?.taskId,
      agentId: filters?.agentId,
      status: filters?.status,
      kind: filters?.kind,
    },
    {
      taskId: sessions.taskId,
      agentId: sessions.agentId,
      status: sessions.status,
      kind: sessions.kind,
    },
  );

  const [data, [{ total }]] = await Promise.all([
    db
      .select({
        id: sessions.id,
        status: sessions.status,
        kind: sessions.kind,
        title: sessions.title,
        agentId: sessions.agentId,
        agentName: agents.name,
        taskId: sessions.taskId,
        taskTitle: tasks.title,
        projectId: sessions.projectId,
        permissionMode: sessions.permissionMode,
        model: sessions.model,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .leftJoin(agents, eq(sessions.agentId, agents.id))
      .leftJoin(tasks, eq(sessions.taskId, tasks.id))
      .where(where)
      .orderBy(desc(sessions.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(sessions).where(where),
  ]);

  return { data, total, page, pageSize };
}

/**
 * Delete a single session. Only ended or idle sessions can be deleted.
 * Active/awaiting_input sessions must be cancelled first.
 * Also cleans up the log file on disk if it exists.
 */
export async function deleteSession(id: string): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.deleteSession(id);
  }
  const session = await getSession(id);
  if (session.status === 'active' || session.status === 'awaiting_input') {
    throw new ConflictError('Cannot delete an active session. Cancel it first.');
  }
  // Clean up log and plan files
  await safeUnlinkMany([session.logFilePath, session.planFilePath]);
  await db.delete(sessions).where(eq(sessions.id, id));
}

/**
 * Delete multiple sessions in bulk. Only deletes ended/idle sessions;
 * skips active/awaiting_input ones and returns the count actually deleted.
 */
export async function deleteSessions(
  ids: string[],
): Promise<{ deletedCount: number; skippedIds: string[] }> {
  if (isDemoMode()) {
    const demo = await import('./session-service.demo');
    return demo.deleteSessions(ids);
  }
  if (ids.length === 0) return { deletedCount: 0, skippedIds: [] };

  // Fetch sessions to identify which can be deleted and gather file paths
  const rows = await db
    .select({
      id: sessions.id,
      status: sessions.status,
      logFilePath: sessions.logFilePath,
      planFilePath: sessions.planFilePath,
    })
    .from(sessions)
    .where(inArray(sessions.id, ids));

  const deletable: typeof rows = [];
  const skippedIds: string[] = [];
  for (const row of rows) {
    if (row.status === 'active' || row.status === 'awaiting_input') {
      skippedIds.push(row.id);
    } else {
      deletable.push(row);
    }
  }

  if (deletable.length === 0) return { deletedCount: 0, skippedIds };

  // Clean up files
  await safeUnlinkMany(deletable.flatMap((row) => [row.logFilePath, row.planFilePath]));

  // Delete from DB
  const deletableIds = deletable.map((r) => r.id);
  await db.delete(sessions).where(inArray(sessions.id, deletableIds));

  return { deletedCount: deletable.length, skippedIds };
}
