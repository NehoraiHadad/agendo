import { eq, and, desc, asc, isNotNull, getTableColumns, count } from 'drizzle-orm';
import { db } from '@/lib/db';
import { brainstormRooms, brainstormParticipants, agents, projects, tasks } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import { NotFoundError, ConflictError, ValidationError } from '@/lib/errors';
import type {
  BrainstormRoom,
  BrainstormParticipant,
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
    project,
    task,
  };
}

// ============================================================================
// List result type (includes aggregate counts)
// ============================================================================

/**
 * Lightweight projection for brainstorm list views.
 * Omits large text columns (`synthesis`) and `config` jsonb
 * that are only needed in the detail view.
 */
export interface BrainstormRoomSummary {
  id: string;
  projectId: string;
  taskId: string | null;
  title: string;
  topic: string;
  status: BrainstormStatus;
  currentWave: number;
  maxWaves: number;
  createdAt: Date;
  updatedAt: Date;
  /** Number of participants in this room. */
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
      id: brainstormRooms.id,
      projectId: brainstormRooms.projectId,
      taskId: brainstormRooms.taskId,
      title: brainstormRooms.title,
      topic: brainstormRooms.topic,
      status: brainstormRooms.status,
      currentWave: brainstormRooms.currentWave,
      maxWaves: brainstormRooms.maxWaves,
      createdAt: brainstormRooms.createdAt,
      updatedAt: brainstormRooms.updatedAt,
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
 * Update the maxWaves cap on a room (e.g. when extending a paused room).
 * Returns the updated record.
 */
export async function updateBrainstormMaxWaves(
  id: string,
  maxWaves: number,
): Promise<BrainstormRoom> {
  const [updated] = await db
    .update(brainstormRooms)
    .set({ maxWaves, updatedAt: new Date() })
    .where(eq(brainstormRooms.id, id))
    .returning();
  if (!updated) throw new NotFoundError('BrainstormRoom', id);
  return updated;
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

/**
 * Persist the log file path for a brainstorm room.
 * Called by the orchestrator after it resolves and opens the log file.
 */
export async function updateBrainstormLogPath(id: string, logFilePath: string): Promise<void> {
  await db
    .update(brainstormRooms)
    .set({ logFilePath, updatedAt: new Date() })
    .where(eq(brainstormRooms.id, id));
}

/**
 * Delete a brainstorm room. Participants are cascade-deleted by the FK constraint.
 * Active and synthesizing rooms cannot be deleted — end them first.
 */
export async function deleteBrainstorm(id: string): Promise<void> {
  const [room] = await db
    .select({ id: brainstormRooms.id, status: brainstormRooms.status })
    .from(brainstormRooms)
    .where(eq(brainstormRooms.id, id))
    .limit(1);

  requireFound(room, 'BrainstormRoom', id);

  if (room.status === 'active' || room.status === 'synthesizing') {
    throw new ValidationError('Cannot delete an active brainstorm room. End it first.');
  }

  await db.delete(brainstormRooms).where(eq(brainstormRooms.id, id));
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

// ============================================================================
// Cross-brainstorm context
// ============================================================================

/**
 * Lightweight projection for completed rooms used as context in new brainstorms.
 */
export interface CompletedRoomSummary {
  id: string;
  title: string;
  synthesis: string;
  createdAt: Date;
}

/**
 * Get completed brainstorm rooms for a project that have a non-null synthesis.
 * Used to populate the "Related brainstorms" picker in the create dialog
 * and to inject context into new brainstorm preambles.
 */
export async function getCompletedRoomsForProject(
  projectId: string,
): Promise<CompletedRoomSummary[]> {
  return db
    .select({
      id: brainstormRooms.id,
      title: brainstormRooms.title,
      synthesis: brainstormRooms.synthesis,
      createdAt: brainstormRooms.createdAt,
    })
    .from(brainstormRooms)
    .where(
      and(
        eq(brainstormRooms.projectId, projectId),
        eq(brainstormRooms.status, 'ended'),
        isNotNull(brainstormRooms.synthesis),
      ),
    )
    .orderBy(desc(brainstormRooms.createdAt)) as Promise<CompletedRoomSummary[]>;
}
