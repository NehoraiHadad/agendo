import { eq, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { taskEvents } from '@/lib/db/schema';
import type { TaskEvent } from '@/lib/types';

export interface CreateEventInput {
  taskId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

export async function createTaskEvent(input: CreateEventInput): Promise<TaskEvent> {
  const [event] = await db
    .insert(taskEvents)
    .values({
      taskId: input.taskId,
      actorType: input.actorType,
      actorId: input.actorId,
      eventType: input.eventType,
      payload: input.payload ?? {},
    })
    .returning();

  return event;
}

/**
 * List events for a task, newest first.
 * Limited to 100 to prevent excessive payload sizes.
 */
export async function listTaskEvents(taskId: string, limit: number = 100): Promise<TaskEvent[]> {
  return db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.createdAt))
    .limit(limit);
}
