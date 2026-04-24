/**
 * Demo-mode shadow for brainstorm-service.
 *
 * Exports fixture data and re-implements every public function from
 * brainstorm-service.ts without touching the database. Mutations return
 * believable typed stubs with no side effects.
 *
 * Imported only via dynamic `await import('./brainstorm-service.demo')` in
 * demo mode so it is tree-shaken from production bundles.
 */

import { randomUUID } from 'crypto';
import { NotFoundError } from '@/lib/errors';
import type { BrainstormRoom, BrainstormParticipant, BrainstormStatus } from '@/lib/types';
import type {
  BrainstormWithDetails,
  BrainstormRoomSummary,
  CompletedRoomSummary,
  CreateBrainstormInput,
} from '@/lib/services/brainstorm-service';
import type { BrainstormOutcome } from '@/lib/db/schema';
import type { BrainstormParticipantStatus } from '@/lib/types';

// ============================================================================
// Canonical demo UUIDs
// ============================================================================

export const DEMO_BRAINSTORM_ROOM_ID = 'eeeeeeee-eeee-4001-e001-eeeeeeeeeeee';

export const DEMO_PARTICIPANT_CLAUDE_ID = 'eeeeeeee-eeee-4002-e002-eeeeeeeeeeee';
export const DEMO_PARTICIPANT_CODEX_ID = 'eeeeeeee-eeee-4003-e003-eeeeeeeeeeee';
export const DEMO_PARTICIPANT_GEMINI_ID = 'eeeeeeee-eeee-4004-e004-eeeeeeeeeeee';

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';
const GEMINI_AGENT_ID = '33333333-3333-4333-a333-333333333333';

const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';
const CODEX_SESSION_ID = '88888888-8888-4888-a888-888888888888';
const GEMINI_SESSION_ID = '99999999-9999-4999-a999-999999999999';

const AGENDO_PROJECT_ID = '44444444-4444-4444-a444-444444444444';

// ============================================================================
// Fixed deterministic timestamps
// ============================================================================

const T_BASE = new Date('2026-04-17T09:00:00.000Z');
const T_WAVE1 = new Date('2026-04-17T09:05:00.000Z');
const T_WAVE2 = new Date('2026-04-17T09:20:00.000Z');
const T_WAVE3 = new Date('2026-04-17T09:35:00.000Z');
const T_ENDED = new Date('2026-04-17T09:45:00.000Z');

// ============================================================================
// Brainstorm room fixture — "Design session reconnect strategy"
// ============================================================================

/**
 * Room outcome for the completed brainstorm (3 waves, converged).
 */
const DEMO_OUTCOME: BrainstormOutcome = {
  endState: 'converged',
  totalWaves: 3,
  totalParticipants: 3,
  activeParticipantsAtEnd: 3,
  evictedCount: 0,
  timeoutCount: 0,
  synthesisParseSuccess: true,
  taskCreationCount: 0,
  totalDurationMs: 2700000, // 45 min
  convergenceWave: 3,
  reflectionWavesTriggered: 0,
  deliverableType: 'decision',
};

/**
 * Final synthesis paragraph capturing the agreed hybrid approach.
 * This is the text that would appear in the "Synthesis" tab of the brainstorm view.
 */
const DEMO_SYNTHESIS =
  'Hybrid approach: the client maintains a local event window (ring buffer) during' +
  ' disconnection. The server tags each SSE event with an epoch+sequence number, where' +
  ' the epoch increments on every worker restart. A dedicated catchup endpoint replays' +
  ' events from a given epoch+seq pair, letting clients seamlessly resume after both' +
  ' network drops and server restarts without replaying stale events from a previous epoch.';

/**
 * Canonical brainstorm room fixture — must satisfy BrainstormRoom (InferSelectModel).
 */
export const DEMO_BRAINSTORM_ROOM: BrainstormRoom = {
  id: DEMO_BRAINSTORM_ROOM_ID,
  projectId: AGENDO_PROJECT_ID,
  taskId: null,
  title: 'Design session reconnect strategy',
  topic:
    'How should the client reconnect to an SSE stream after a network drop or server restart?' +
    ' Consider event replay, cursor tracking, and cross-restart consistency.',
  status: 'ended',
  currentWave: 3,
  maxWaves: 10,
  config: {
    convergenceMode: 'unanimous',
    minWavesBeforePass: 2,
    synthesisMode: 'single',
    synthesisAgentId: CLAUDE_AGENT_ID,
    deliverableType: 'decision',
    goal: 'Agree on a session reconnect strategy for agendo SSE streams',
  },
  synthesis: DEMO_SYNTHESIS,
  outcome: DEMO_OUTCOME,
  logFilePath: '/data/agendo/logs/brainstorm-eeeeeeee.jsonl',
  leaderParticipantId: DEMO_PARTICIPANT_CLAUDE_ID,
  createdAt: T_BASE,
  updatedAt: T_ENDED,
};

// ============================================================================
// Brainstorm participant fixtures — Claude, Codex, Gemini
// ============================================================================

/**
 * Three participant rows, each satisfying BrainstormParticipant (InferSelectModel).
 */
export const DEMO_BRAINSTORM_PARTICIPANTS: BrainstormParticipant[] = [
  {
    id: DEMO_PARTICIPANT_CLAUDE_ID,
    roomId: DEMO_BRAINSTORM_ROOM_ID,
    agentId: CLAUDE_AGENT_ID,
    sessionId: CLAUDE_SESSION_ID,
    model: 'claude-opus-4-5-20250514',
    role: 'architect',
    status: 'active',
    joinedAt: T_BASE,
  },
  {
    id: DEMO_PARTICIPANT_CODEX_ID,
    roomId: DEMO_BRAINSTORM_ROOM_ID,
    agentId: CODEX_AGENT_ID,
    sessionId: CODEX_SESSION_ID,
    model: 'codex-1',
    role: 'critic',
    status: 'active',
    joinedAt: T_BASE,
  },
  {
    id: DEMO_PARTICIPANT_GEMINI_ID,
    roomId: DEMO_BRAINSTORM_ROOM_ID,
    agentId: GEMINI_AGENT_ID,
    sessionId: GEMINI_SESSION_ID,
    model: 'gemini-2.5-pro',
    role: 'pragmatist',
    status: 'active',
    joinedAt: T_BASE,
  },
];

// ============================================================================
// Agent metadata for enriched responses
// ============================================================================

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

const AGENT_BINARY_PATHS: Record<string, string> = {
  [CLAUDE_AGENT_ID]: '/usr/local/bin/claude',
  [CODEX_AGENT_ID]: '/usr/local/bin/codex',
  [GEMINI_AGENT_ID]: '/usr/local/bin/gemini',
};

// Session → participant lookup (for getParticipantBySessionId)
const SESSION_TO_PARTICIPANT_ID: Record<string, string> = {
  [CLAUDE_SESSION_ID]: DEMO_PARTICIPANT_CLAUDE_ID,
  [CODEX_SESSION_ID]: DEMO_PARTICIPANT_CODEX_ID,
  [GEMINI_SESSION_ID]: DEMO_PARTICIPANT_GEMINI_ID,
};

// All demo rooms
const ALL_ROOMS: BrainstormRoom[] = [DEMO_BRAINSTORM_ROOM];

// ============================================================================
// Query functions
// ============================================================================

/**
 * Get a brainstorm room with participants and project/task details.
 */
export function getBrainstorm(id: string): BrainstormWithDetails {
  const room = ALL_ROOMS.find((r) => r.id === id);
  if (!room) throw new NotFoundError('BrainstormRoom', id);

  const participants = DEMO_BRAINSTORM_PARTICIPANTS.filter((p) => p.roomId === id).map((p) => ({
    ...p,
    agentName: AGENT_NAMES[p.agentId] ?? 'Unknown',
    agentSlug: AGENT_SLUGS[p.agentId] ?? '',
    agentBinaryPath: AGENT_BINARY_PATHS[p.agentId] ?? '',
  }));

  const project =
    room.projectId === AGENDO_PROJECT_ID ? { id: AGENDO_PROJECT_ID, name: 'agendo' } : null;

  return { ...room, participants, project, task: null };
}

/**
 * List brainstorm rooms with optional filters.
 */
export function listBrainstorms(filters?: {
  projectId?: string;
  status?: BrainstormStatus;
}): BrainstormRoomSummary[] {
  let rooms = ALL_ROOMS;

  if (filters?.projectId) {
    rooms = rooms.filter((r) => r.projectId === filters.projectId);
  }
  if (filters?.status) {
    rooms = rooms.filter((r) => r.status === filters.status);
  }

  return rooms.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    taskId: r.taskId,
    title: r.title,
    topic: r.topic,
    status: r.status,
    currentWave: r.currentWave,
    maxWaves: r.maxWaves,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    participantCount: DEMO_BRAINSTORM_PARTICIPANTS.filter((p) => p.roomId === r.id).length,
  }));
}

/**
 * Get completed rooms with synthesis for a project.
 */
export function getCompletedRoomsForProject(projectId: string): CompletedRoomSummary[] {
  return ALL_ROOMS.filter(
    (r) => r.projectId === projectId && r.status === 'ended' && r.synthesis != null,
  ).map((r) => ({
    id: r.id,
    title: r.title,
    synthesis: r.synthesis as string,
    createdAt: r.createdAt,
  }));
}

/**
 * Find a brainstorm participant by their session ID.
 */
export function getParticipantBySessionId(sessionId: string): {
  id: string;
  roomId: string;
  agentId: string;
  role: string | null;
  agentName: string;
  agentSlug: string;
} | null {
  const participantId = SESSION_TO_PARTICIPANT_ID[sessionId];
  if (!participantId) return null;

  const participant = DEMO_BRAINSTORM_PARTICIPANTS.find((p) => p.id === participantId);
  if (!participant) return null;

  return {
    id: participant.id,
    roomId: participant.roomId,
    agentId: participant.agentId,
    role: participant.role,
    agentName: AGENT_NAMES[participant.agentId] ?? 'Unknown',
    agentSlug: AGENT_SLUGS[participant.agentId] ?? '',
  };
}

// ============================================================================
// Mutation stubs — no side effects, return typed stubs
// ============================================================================

/**
 * Create brainstorm — returns a stub room with waiting status.
 */
export function createBrainstorm(input: CreateBrainstormInput): BrainstormRoom {
  const now = new Date();
  return {
    id: randomUUID(),
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    title: input.title,
    topic: input.topic,
    status: 'waiting',
    currentWave: 0,
    maxWaves: input.maxWaves ?? 10,
    config: input.config ?? {},
    synthesis: null,
    outcome: null,
    logFilePath: null,
    leaderParticipantId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update brainstorm status — returns stub with new status.
 */
export function updateBrainstormStatus(id: string, status: BrainstormStatus): BrainstormRoom {
  const room = ALL_ROOMS.find((r) => r.id === id) ?? DEMO_BRAINSTORM_ROOM;
  return { ...room, id, status, updatedAt: new Date() };
}

/** Update wave counter — no-op stub. */
export function updateBrainstormWave(_id: string, _wave: number): void {
  // No side effects in demo mode
}

/**
 * Update maxWaves — returns stub with new value.
 */
export function updateBrainstormMaxWaves(id: string, maxWaves: number): BrainstormRoom {
  const room = ALL_ROOMS.find((r) => r.id === id) ?? DEMO_BRAINSTORM_ROOM;
  return { ...room, id, maxWaves, updatedAt: new Date() };
}

/** Set synthesis text — no-op stub. */
export function setBrainstormSynthesis(_id: string, _synthesis: string): void {
  // No side effects in demo mode
}

/** Set outcome — no-op stub. */
export function setBrainstormOutcome(_id: string, _outcome: BrainstormOutcome): void {
  // No side effects in demo mode
}

/**
 * Add participant — returns a new participant stub.
 */
export function addParticipant(
  roomId: string,
  agentId: string,
  model?: string,
): BrainstormParticipant {
  return {
    id: randomUUID(),
    roomId,
    agentId,
    sessionId: null,
    model: model ?? null,
    role: null,
    status: 'pending',
    joinedAt: new Date(),
  };
}

/** Remove participant by setting status to left — no-op stub. */
export function removeParticipant(_roomId: string, _participantId: string): void {
  // No side effects in demo mode
}

/** Associate participant with a session — no-op stub. */
export function updateParticipantSession(_participantId: string, _sessionId: string): void {
  // No side effects in demo mode
}

/** Update participant model — no-op stub. */
export function updateParticipantModel(_participantId: string, _model: string | null): void {
  // No side effects in demo mode
}

/** Update participant agent — no-op stub. */
export function updateParticipantAgent(_participantId: string, _agentId: string): void {
  // No side effects in demo mode
}

/** Update participant status — no-op stub. */
export function updateParticipantStatus(
  _participantId: string,
  _status: BrainstormParticipantStatus,
): void {
  // No side effects in demo mode
}

/** Update participant role — no-op stub. */
export function updateParticipantRole(_participantId: string, _role: string): void {
  // No side effects in demo mode
}

/** Update log path — no-op stub. */
export function updateBrainstormLogPath(_id: string, _logFilePath: string): void {
  // No side effects in demo mode
}

/** Delete brainstorm — no-op stub. */
export function deleteBrainstorm(_id: string): void {
  // No side effects in demo mode
}

/**
 * Extend brainstorm — returns stub with increased maxWaves and waiting status.
 */
export function extendBrainstorm(id: string, additionalWaves: number): BrainstormRoom {
  const room = ALL_ROOMS.find((r) => r.id === id) ?? DEMO_BRAINSTORM_ROOM;
  return {
    ...room,
    id,
    maxWaves: room.maxWaves + additionalWaves,
    status: 'waiting',
    updatedAt: new Date(),
  };
}

/** Add wave budget — no-op stub. */
export function addWaveBudget(_id: string, _additionalWaves: number): void {
  // No side effects in demo mode
}

// Expose wave timestamps for SSE replay in Phase 2
export { T_WAVE1, T_WAVE2, T_WAVE3 };
