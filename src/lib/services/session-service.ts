import { eq, and, desc, count, getTableColumns } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sessions, agents, tasks } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import type { Session } from '@/lib/types';

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
      kind: input.kind ?? 'execution',
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      idleTimeoutSec: input.idleTimeoutSec ?? 600,
      status: 'idle', // session starts idle, goes active when worker claims it
      initialPrompt: input.initialPrompt,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools,
      ...(input.model ? { model: input.model } : {}),
    })
    .returning();
  return session;
}

export async function getSession(id: string): Promise<Session> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return requireFound(session, 'Session', id);
}

export interface SessionWithAgent extends Session {
  agentName: string;
  taskTitle: string | null;
}

export async function listConversationsByProject(
  projectId: string,
  limit = 20,
): Promise<SessionWithAgent[]> {
  const rows = await db
    .select({
      ...getTableColumns(sessions),
      agentName: agents.name,
      taskTitle: tasks.title,
    })
    .from(sessions)
    .leftJoin(tasks, eq(sessions.taskId, tasks.id))
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(and(eq(sessions.projectId, projectId), eq(sessions.kind, 'conversation')))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
  return rows as SessionWithAgent[];
}

export async function listExecutionSessionsByProject(
  projectId: string,
  limit = 20,
): Promise<SessionWithAgent[]> {
  const rows = await db
    .select({
      ...getTableColumns(sessions),
      agentName: agents.name,
      taskTitle: tasks.title,
    })
    .from(sessions)
    .leftJoin(tasks, eq(sessions.taskId, tasks.id))
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(and(eq(sessions.projectId, projectId), eq(sessions.kind, 'execution')))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
  return rows as SessionWithAgent[];
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
