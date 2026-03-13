import { eq, and, desc, asc, getTableColumns, count } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  brainstormRooms,
  brainstormParticipants,
  brainstormMessages,
  agents,
  projects,
  tasks,
} from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import { NotFoundError, ConflictError } from '@/lib/errors';
import type {
  BrainstormRoom,
  BrainstormParticipant,
  BrainstormMessage,
  BrainstormStatus,
  BrainstormParticipantStatus,
} from '@/lib/types';

// ============================================================================
// Input / Output types
// ============================================================================

export interface CreateBrainstormInput {
  projectId: string;
  taskId?: string;
  title: string;
  topic: string;
  maxWaves?: number;
  config?: Record<string, unknown>;
  participants: Array<{
    agentId: string;
    model?: string;
  }>;
}

export interface BrainstormWithDetails extends BrainstormRoom {
  participants: Array<BrainstormParticipant & { agentName: string; agentSlug: string }>;
  messages: BrainstormMessage[];
  project: { id: string; name: string } | null;
  task: { id: string; title: string } | null;
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Create a brainstorm room and its initial participants in a single transaction.
 */
export async function createBrainstorm(input: CreateBrainstormInput): Promise<BrainstormRoom> {
  return db.transaction(async (tx) => {
    const [room] = await tx
      .insert(brainstormRooms)
      .values({
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        title: input.title,
        topic: input.topic,
        maxWaves: input.maxWaves ?? 10,
        config: input.config ?? {},
      })
      .returning();

    if (input.participants.length > 0) {
      await tx.insert(brainstormParticipants).values(
        input.participants.map((p) => ({
          roomId: room.id,
          agentId: p.agentId,
          model: p.model ?? null,
        })),
      );
    }

    return room;
  });
}

/**
 * Get a brainstorm room with participants (+ agent details), messages, project, and task.
 */
export async function getBrainstorm(id: string): Promise<BrainstormWithDetails> {
  // Fetch the base room record
  const [room] = await db.select().from(brainstormRooms).where(eq(brainstormRooms.id, id)).limit(1);

  requireFound(room, 'BrainstormRoom', id);

  // Fetch participants with agent name and slug
  const participantRows = await db
    .select({
      ...getTableColumns(brainstormParticipants),
      agentName: agents.name,
      agentSlug: agents.slug,
    })
    .from(brainstormParticipants)
    .innerJoin(agents, eq(brainstormParticipants.agentId, agents.id))
    .where(eq(brainstormParticipants.roomId, id))
    .orderBy(asc(brainstormParticipants.joinedAt));

  // Fetch messages ordered chronologically
  const messageRows = await db
    .select()
    .from(brainstormMessages)
    .where(eq(brainstormMessages.roomId, id))
    .orderBy(asc(brainstormMessages.createdAt));

  // Fetch project
  let project: { id: string; name: string } | null = null;
  if (room.projectId) {
    const [proj] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.id, room.projectId))
      .limit(1);
    project = proj ?? null;
  }

  // Fetch task
  let task: { id: string; title: string } | null = null;
  if (room.taskId) {
    const [t] = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.id, room.taskId))
      .limit(1);
    task = t ?? null;
  }

  return {
    ...room,
    participants: participantRows,
    messages: messageRows,
    project,
    task,
  };
}

// ============================================================================
// List result type (includes aggregate counts)
// ============================================================================

export interface BrainstormRoomSummary extends BrainstormRoom {
  /** Number of non-left participants in this room. */
  participantCount: number;
}

/**
 * List brainstorm rooms with optional filters, newest first.
 * Includes participant count via a correlated subquery.
 */
export async function listBrainstorms(filters?: {
  projectId?: string;
  status?: BrainstormStatus;
}): Promise<BrainstormRoomSummary[]> {
  const conditions = [];
  if (filters?.projectId) conditions.push(eq(brainstormRooms.projectId, filters.projectId));
  if (filters?.status) conditions.push(eq(brainstormRooms.status, filters.status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      ...getTableColumns(brainstormRooms),
      participantCount: count(brainstormParticipants.id),
    })
    .from(brainstormRooms)
    .leftJoin(brainstormParticipants, eq(brainstormParticipants.roomId, brainstormRooms.id))
    .where(where)
    .groupBy(brainstormRooms.id)
    .orderBy(desc(brainstormRooms.createdAt));

  return rows.map((r) => ({ ...r, participantCount: Number(r.participantCount) }));
}

/**
 * Update the status of a brainstorm room. Returns the updated record.
 */
export async function updateBrainstormStatus(
  id: string,
  status: BrainstormStatus,
): Promise<BrainstormRoom> {
  const [updated] = await db
    .update(brainstormRooms)
    .set({ status, updatedAt: new Date() })
    .where(eq(brainstormRooms.id, id))
    .returning();

  if (!updated) throw new NotFoundError('BrainstormRoom', id);
  return updated;
}

/**
 * Update the currentWave counter on a room.
 */
export async function updateBrainstormWave(id: string, wave: number): Promise<void> {
  await db
    .update(brainstormRooms)
    .set({ currentWave: wave, updatedAt: new Date() })
    .where(eq(brainstormRooms.id, id));
}

/**
 * Store the final synthesis text on a completed room.
 */
export async function setBrainstormSynthesis(id: string, synthesis: string): Promise<void> {
  await db
    .update(brainstormRooms)
    .set({ synthesis, updatedAt: new Date() })
    .where(eq(brainstormRooms.id, id));
}

// ============================================================================
// Participants
// ============================================================================

/**
 * Add a new participant to a room. Returns the created participant record.
 */
export async function addParticipant(
  roomId: string,
  agentId: string,
  model?: string,
): Promise<BrainstormParticipant> {
  const [participant] = await db
    .insert(brainstormParticipants)
    .values({ roomId, agentId, model: model ?? null })
    .returning();
  return participant;
}

/**
 * Soft-remove a participant by setting their status to 'left'.
 * History is preserved for replay.
 */
export async function removeParticipant(roomId: string, agentId: string): Promise<void> {
  await db
    .update(brainstormParticipants)
    .set({ status: 'left' })
    .where(
      and(eq(brainstormParticipants.roomId, roomId), eq(brainstormParticipants.agentId, agentId)),
    );
}

/**
 * Associate a participant with the session spawned for them by the orchestrator.
 */
export async function updateParticipantSession(
  participantId: string,
  sessionId: string,
): Promise<void> {
  await db
    .update(brainstormParticipants)
    .set({ sessionId })
    .where(eq(brainstormParticipants.id, participantId));
}

/**
 * Update the lifecycle status of a participant.
 */
export async function updateParticipantStatus(
  participantId: string,
  status: BrainstormParticipantStatus,
): Promise<void> {
  await db
    .update(brainstormParticipants)
    .set({ status })
    .where(eq(brainstormParticipants.id, participantId));
}

// ============================================================================
// Messages
// ============================================================================

export interface AddMessageInput {
  roomId: string;
  wave: number;
  senderType: 'agent' | 'user';
  senderAgentId?: string;
  content: string;
  isPass?: boolean;
}

/**
 * Persist a message to the room. Returns the saved record.
 */
export async function addMessage(input: AddMessageInput): Promise<BrainstormMessage> {
  const [message] = await db
    .insert(brainstormMessages)
    .values({
      roomId: input.roomId,
      wave: input.wave,
      senderType: input.senderType,
      senderAgentId: input.senderAgentId ?? null,
      content: input.content,
      isPass: input.isPass ?? false,
    })
    .returning();
  return message;
}

/**
 * Get messages for a room, optionally filtered to a specific wave, in chronological order.
 */
export async function getMessages(roomId: string, wave?: number): Promise<BrainstormMessage[]> {
  const conditions = [eq(brainstormMessages.roomId, roomId)];
  if (wave !== undefined) conditions.push(eq(brainstormMessages.wave, wave));

  return db
    .select()
    .from(brainstormMessages)
    .where(and(...conditions))
    .orderBy(asc(brainstormMessages.createdAt));
}

/**
 * Extend an ended brainstorm room by adding more waves and re-queueing it.
 * The orchestrator resumes from the last completed wave (room.currentWave + 1).
 */
export async function extendBrainstorm(
  id: string,
  additionalWaves: number,
): Promise<BrainstormRoom> {
  const [room] = await db.select().from(brainstormRooms).where(eq(brainstormRooms.id, id)).limit(1);

  requireFound(room, 'BrainstormRoom', id);

  if (room.status !== 'ended') {
    throw new ConflictError(
      `Cannot extend a brainstorm room with status '${room.status}'. Only 'ended' rooms can be extended.`,
    );
  }

  const [updated] = await db
    .update(brainstormRooms)
    .set({ maxWaves: room.maxWaves + additionalWaves, status: 'waiting', updatedAt: new Date() })
    .where(eq(brainstormRooms.id, id))
    .returning();

  if (!updated) throw new NotFoundError('BrainstormRoom', id);
  return updated;
}
