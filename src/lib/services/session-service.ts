import { eq, and, inArray, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import type { Session } from '@/lib/types';

export interface CreateSessionInput {
  taskId: string;
  agentId: string;
  capabilityId: string;
  idleTimeoutSec?: number;
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const [session] = await db
    .insert(sessions)
    .values({
      taskId: input.taskId,
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      idleTimeoutSec: input.idleTimeoutSec ?? 600,
      status: 'active',
    })
    .returning();
  return session;
}

export async function getSession(id: string): Promise<Session> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (!session) throw new NotFoundError('Session', id);
  return session;
}

export async function updateSession(id: string, patch: Partial<Session>): Promise<void> {
  await db.update(sessions).set(patch).where(eq(sessions.id, id));
}

export async function listSessionsByTask(taskId: string): Promise<Session[]> {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(desc(sessions.createdAt));
}

/**
 * Atomically claim a session for a worker.
 * Returns the claimed session or null if already claimed by another worker.
 */
export async function claimSession(
  sessionId: string,
  workerId: string,
): Promise<Session | null> {
  const [claimed] = await db
    .update(sessions)
    .set({ workerId, status: 'active', startedAt: new Date() })
    .where(
      and(
        eq(sessions.id, sessionId),
        inArray(sessions.status, ['idle', 'active']),
      ),
    )
    .returning();
  return claimed ?? null;
}

/**
 * Get the active/awaiting_input/idle session for a task+agent combination.
 * Used to check for existing sessions before creating new ones.
 */
export async function getActiveSession(
  taskId: string,
  agentId: string,
): Promise<Session | null> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.taskId, taskId),
        eq(sessions.agentId, agentId),
        inArray(sessions.status, ['active', 'awaiting_input', 'idle']),
      ),
    )
    .limit(1);
  return session ?? null;
}
