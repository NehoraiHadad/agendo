import {
  eq,
  and,
  desc,
  count,
  getTableColumns,
  or,
  ilike,
  inArray,
  isNull,
  isNotNull,
} from 'drizzle-orm';
import { db } from '@/lib/db';
import { sessions, agents, agentCapabilities, tasks, projects } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { enqueueSession } from '@/lib/worker/queue';
import type { Session } from '@/lib/types';
import type { AgendoControl } from '@/lib/realtime/events';

export type SessionKind = 'conversation' | 'execution';

export interface CreateSessionInput {
  taskId?: string;
  projectId?: string;
  kind?: SessionKind;
  agentId: string;
  capabilityId: string;
  idleTimeoutSec?: number;
  initialPrompt?: string;
  permissionMode?: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';
  allowedTools?: string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  parentSessionId?: string;
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
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
      capabilityId: input.capabilityId,
      idleTimeoutSec: input.idleTimeoutSec ?? 600,
      status: 'idle', // session starts idle, goes active when worker claims it
      initialPrompt: input.initialPrompt,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    })
    .returning();
  return session;
}

export async function getSession(id: string): Promise<Session> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return requireFound(session, 'Session', id);
}

export interface SessionWithDetails extends Session {
  agentName: string | null;
  agentSlug: string | null;
  capLabel: string | null;
  taskTitle: string | null;
  projectName: string | null;
}

export async function getSessionWithDetails(id: string): Promise<SessionWithDetails> {
  const [row] = await db
    .select({
      session: sessions,
      agentName: agents.name,
      agentSlug: agents.slug,
      capLabel: agentCapabilities.label,
      taskTitle: tasks.title,
      projectName: projects.name,
    })
    .from(sessions)
    .leftJoin(agents, eq(sessions.agentId, agents.id))
    .leftJoin(agentCapabilities, eq(sessions.capabilityId, agentCapabilities.id))
    .leftJoin(tasks, eq(sessions.taskId, tasks.id))
    .leftJoin(projects, eq(projects.id, sessions.projectId))
    .where(eq(sessions.id, id))
    .limit(1);

  if (!row) throw new NotFoundError('Session', id);

  return {
    ...row.session,
    agentName: row.agentName,
    agentSlug: row.agentSlug,
    capLabel: row.capLabel,
    taskTitle: row.taskTitle,
    projectName: row.projectName,
  };
}

export async function updateSessionTitle(
  id: string,
  title: string | null,
): Promise<{ id: string; title: string | null }> {
  const [updated] = await db
    .update(sessions)
    .set({ title })
    .where(eq(sessions.id, id))
    .returning({ id: sessions.id, title: sessions.title });

  if (!updated) throw new NotFoundError('Session', id);
  return updated;
}

export async function cancelSession(id: string): Promise<void> {
  const result = await db
    .update(sessions)
    .set({ status: 'ended', endedAt: new Date() })
    .where(and(eq(sessions.id, id), inArray(sessions.status, ['active', 'awaiting_input'])))
    .returning({ id: sessions.id });

  if (result.length === 0) {
    throw new ConflictError('Session not active or already ended');
  }

  const control: AgendoControl = { type: 'cancel' };
  await publish(channelName('agendo_control', id), control);
}

export async function interruptSession(id: string): Promise<void> {
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.status, 'active')))
    .limit(1);

  if (!session) {
    throw new ConflictError('Session not active');
  }

  const control: AgendoControl = { type: 'interrupt' };
  await publish(channelName('agendo_control', id), control);
}

export async function getSessionLogInfo(
  id: string,
): Promise<{ logFilePath: string | null; status: string } | null> {
  const [row] = await db
    .select({ logFilePath: sessions.logFilePath, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return row ?? null;
}

export async function getSessionStatus(id: string): Promise<{ status: string } | null> {
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
  const parent = await getSession(parentId);
  const [fork] = await db
    .insert(sessions)
    .values({
      taskId: parent.taskId,
      projectId: parent.projectId,
      kind: parent.kind,
      agentId: parent.agentId,
      capabilityId: parent.capabilityId,
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
      forkSourceRef: parent.sessionRef ?? null,
    })
    .returning();

  // Enqueue immediately when the parent has a sessionRef and an initialPrompt is
  // provided. This starts the fork right away without waiting for the user to
  // send the first message manually.
  if (parent.sessionRef && initialPrompt) {
    await enqueueSession({
      sessionId: fork.id,
      resumeSessionAt: resumeAt,
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
 * The caller is responsible for calling enqueueSession() when the time is right
 * (immediately for idle parents; from the worker's onExit for active parents).
 */
export async function restartFreshFromSession(
  parentId: string,
  planContent: string | null,
  permissionMode: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk',
): Promise<Session> {
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
      capabilityId: parent.capabilityId,
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

export async function listSessionsByProject(
  projectId: string,
  filter: 'free-chats' | 'task-sessions',
  limit = 20,
): Promise<SessionWithAgent[]> {
  const taskFilter = filter === 'free-chats' ? isNull(sessions.taskId) : isNotNull(sessions.taskId);
  const rows = await db
    .select({
      ...getTableColumns(sessions),
      agentName: agents.name,
      taskTitle: tasks.title,
    })
    .from(sessions)
    .leftJoin(tasks, eq(sessions.taskId, tasks.id))
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(and(eq(sessions.projectId, projectId), taskFilter))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
  return rows as SessionWithAgent[];
}

/** @deprecated Use listSessionsByProject(projectId, 'free-chats', limit) */
export async function listFreeChatsByProject(
  projectId: string,
  limit = 20,
): Promise<SessionWithAgent[]> {
  return listSessionsByProject(projectId, 'free-chats', limit);
}

/** @deprecated Use listSessionsByProject(projectId, 'task-sessions', limit) */
export async function listTaskSessionsByProject(
  projectId: string,
  limit = 20,
): Promise<SessionWithAgent[]> {
  return listSessionsByProject(projectId, 'task-sessions', limit);
}

export interface SearchSessionResult {
  id: string;
  title: string;
  status: string;
  agentName: string;
}

export async function searchSessions(q: string, limit = 5): Promise<SearchSessionResult[]> {
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      initialPrompt: sessions.initialPrompt,
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
    title: row.title ?? row.initialPrompt?.slice(0, 80) ?? 'Untitled session',
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

export async function listSessions(filters?: ListSessionsInput): Promise<{
  data: Session[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const conditions = [];
  if (filters?.taskId) conditions.push(eq(sessions.taskId, filters.taskId));
  if (filters?.agentId) conditions.push(eq(sessions.agentId, filters.agentId));
  if (filters?.status)
    conditions.push(
      eq(sessions.status, filters.status as 'active' | 'awaiting_input' | 'idle' | 'ended'),
    );
  if (filters?.kind) conditions.push(eq(sessions.kind, filters.kind));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, [{ total }]] = await Promise.all([
    db
      .select({
        ...getTableColumns(sessions),
        agentName: agents.name,
        taskTitle: tasks.title,
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
  const session = await getSession(id);
  if (session.status === 'active' || session.status === 'awaiting_input') {
    throw new ConflictError('Cannot delete an active session. Cancel it first.');
  }
  // Clean up log file
  if (session.logFilePath) {
    const { unlink } = await import('node:fs/promises');
    await unlink(session.logFilePath).catch(() => {});
  }
  // Clean up plan file
  if (session.planFilePath) {
    const { unlink } = await import('node:fs/promises');
    await unlink(session.planFilePath).catch(() => {});
  }
  await db.delete(sessions).where(eq(sessions.id, id));
}

/**
 * Delete multiple sessions in bulk. Only deletes ended/idle sessions;
 * skips active/awaiting_input ones and returns the count actually deleted.
 */
export async function deleteSessions(
  ids: string[],
): Promise<{ deletedCount: number; skippedIds: string[] }> {
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
  const { unlink } = await import('node:fs/promises');
  await Promise.allSettled(
    deletable.flatMap((row) => {
      const paths = [row.logFilePath, row.planFilePath].filter(Boolean) as string[];
      return paths.map((p) => unlink(p));
    }),
  );

  // Delete from DB
  const deletableIds = deletable.map((r) => r.id);
  await db.delete(sessions).where(inArray(sessions.id, deletableIds));

  return { deletedCount: deletable.length, skippedIds };
}
