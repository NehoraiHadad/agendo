import { eq, desc, asc, isNotNull, getTableColumns, count, and, sql } from 'drizzle-orm';
import { buildFilters } from '@/lib/db/filter-builder';
import { db } from '@/lib/db';
import type { BrainstormConfig } from '@/lib/db/schema';
import { brainstormRooms, brainstormParticipants, agents, projects, tasks } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import { getById } from '@/lib/services/db-helpers';
import { ConflictError, ValidationError } from '@/lib/errors';

/**
 * Room statuses that allow participant mutations (add/remove).
 */
const MUTABLE_STATUSES: readonly string[] = ['waiting', 'active', 'paused'];
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
  config?: BrainstormConfig;
  participants: Array<{
    agentId: string;
    model?: string;
  }>;
}

export interface BrainstormWithDetails extends BrainstormRoom {
  participants: Array<
    BrainstormParticipant & { agentName: string; agentSlug: string; agentBinaryPath: string }
  >;
  project: { id: string; name: string } | null;
  task: { id: string; title: string } | null;
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Create a brainstorm room and its initial participants in a single transaction.
 * Validates minimum participant count at the service layer.
 */
export async function createBrainstorm(input: CreateBrainstormInput): Promise<BrainstormRoom> {
  if (input.participants.length < 2) {
    throw new ValidationError('At least 2 participants are required to create a brainstorm.');
  }

  // Validate all agentIds exist
  const agentIds = input.participants.map((p) => p.agentId);
  const existingAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(sql`${agents.id} IN ${agentIds}`);
  const existingIds = new Set(existingAgents.map((a) => a.id));
  const missing = agentIds.filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    throw new ValidationError(`Agent(s) not found: ${missing.join(', ')}`);
  }

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
  const room = await getById(brainstormRooms, id, 'BrainstormRoom');

  // Fetch participants with agent name and slug
  const participantRows = await db
    .select({
      ...getTableColumns(brainstormParticipants),
      agentName: agents.name,
      agentSlug: agents.slug,
      agentBinaryPath: agents.binaryPath,
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
  const where = buildFilters(
    { projectId: filters?.projectId, status: filters?.status },
    { projectId: brainstormRooms.projectId, status: brainstormRooms.status },
  );

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

  requireFound(updated, 'BrainstormRoom', id);
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
  requireFound(updated, 'BrainstormRoom', id);
  return updated;
}

/**
 * Store the structured outcome data on a completed room.
 */
export async function setBrainstormOutcome(
  id: string,
  outcome: import('@/lib/db/schema').BrainstormOutcome,
): Promise<void> {
  await db
    .update(brainstormRooms)
    .set({ outcome, updatedAt: new Date() })
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
 * Validates room status and agent existence at the service layer.
 * Uses SELECT FOR UPDATE to prevent concurrent mutations.
 */
export async function addParticipant(
  roomId: string,
  agentId: string,
  model?: string,
): Promise<BrainstormParticipant> {
  return db.transaction(async (tx) => {
    // Lock the room row and validate status atomically
    const result = await tx.execute(
      sql`SELECT id, status FROM brainstorm_rooms WHERE id = ${roomId} FOR UPDATE`,
    );
    const room = result.rows[0] as { id: string; status: string } | undefined;
    if (!room) {
      throw new ValidationError(`BrainstormRoom '${roomId}' not found.`);
    }
    if (!MUTABLE_STATUSES.includes(room.status)) {
      throw new ConflictError(
        `Cannot add participants to a brainstorm room with status '${room.status}'.`,
      );
    }

    // Validate agent exists
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) {
      throw new ValidationError(`Agent '${agentId}' not found.`);
    }

    const [participant] = await tx
      .insert(brainstormParticipants)
      .values({ roomId, agentId, model: model ?? null })
      .returning();
    return participant;
  });
}

/**
 * Soft-remove a participant by setting their status to 'left'.
 * Uses participantId (not agentId) to target exactly one slot,
 * which is critical when duplicate agents are in the room.
 * Validates room status before allowing removal.
 */
export async function removeParticipant(roomId: string, participantId: string): Promise<void> {
  // Validate room status
  const [room] = await db
    .select({ id: brainstormRooms.id, status: brainstormRooms.status })
    .from(brainstormRooms)
    .where(eq(brainstormRooms.id, roomId))
    .limit(1);

  if (!room) {
    throw new ValidationError(`BrainstormRoom '${roomId}' not found.`);
  }
  if (!MUTABLE_STATUSES.includes(room.status)) {
    throw new ConflictError(
      `Cannot remove participants from a brainstorm room with status '${room.status}'.`,
    );
  }

  const [updated] = await db
    .update(brainstormParticipants)
    .set({ status: 'left' })
    .where(
      and(eq(brainstormParticipants.id, participantId), eq(brainstormParticipants.roomId, roomId)),
    )
    .returning({ id: brainstormParticipants.id });

  if (!updated) {
    throw new ValidationError(`Participant '${participantId}' not found in room '${roomId}'.`);
  }
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
 * Persist the participant's currently active model.
 */
export async function updateParticipantModel(
  participantId: string,
  model: string | null,
): Promise<void> {
  await db
    .update(brainstormParticipants)
    .set({ model })
    .where(eq(brainstormParticipants.id, participantId));
}

/**
 * Update the agent assigned to a participant slot.
 */
export async function updateParticipantAgent(
  participantId: string,
  agentId: string,
): Promise<void> {
  await db
    .update(brainstormParticipants)
    .set({ agentId })
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
 * Update the role of a participant.
 */
export async function updateParticipantRole(participantId: string, role: string): Promise<void> {
  await db
    .update(brainstormParticipants)
    .set({ role })
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
  const room = await getById(brainstormRooms, id, 'BrainstormRoom');

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

  requireFound(updated, 'BrainstormRoom', id);
  return updated;
}

/**
 * Add wave budget to any room (regardless of status).
 * Unlike extendBrainstorm, this does NOT change the room status —
 * it just bumps maxWaves so the orchestrator has room to continue.
 */
export async function addWaveBudget(id: string, additionalWaves: number): Promise<void> {
  await db
    .update(brainstormRooms)
    .set({
      maxWaves: sql`${brainstormRooms.maxWaves} + ${additionalWaves}`,
      updatedAt: new Date(),
    })
    .where(eq(brainstormRooms.id, id));
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
