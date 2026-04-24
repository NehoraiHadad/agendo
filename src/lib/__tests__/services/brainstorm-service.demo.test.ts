/**
 * Demo mode tests for brainstorm-service.
 *
 * Strategy: mock isDemoMode() to true and mock DB to throw on access, then
 * exercise the real service functions. The demo branch must route to the
 * shadow and never touch the DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Demo mode on before any imports ----------------------------------------

vi.mock('@/lib/demo/flag', () => ({
  isDemoMode: vi.fn(() => true),
}));

// Safety-net: DB must not be accessed in demo mode
vi.mock('@/lib/db', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('DB should not be accessed in demo mode');
      },
    },
  ),
}));

// Stubs for modules that brainstorm-service imports at module level
vi.mock('@/lib/brainstorm/leader', () => ({
  selectLeader: vi.fn(() => null),
}));

vi.mock('@/lib/worker/brainstorm-personas', () => ({
  inferProviderFromAgentSlug: vi.fn(() => 'claude'),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  createBrainstorm,
  getBrainstorm,
  listBrainstorms,
  updateBrainstormStatus,
  updateBrainstormWave,
  updateBrainstormMaxWaves,
  setBrainstormSynthesis,
  setBrainstormOutcome,
  addParticipant,
  removeParticipant,
  updateParticipantSession,
  updateParticipantModel,
  updateParticipantAgent,
  updateParticipantStatus,
  updateParticipantRole,
  getParticipantBySessionId,
  updateBrainstormLogPath,
  deleteBrainstorm,
  extendBrainstorm,
  addWaveBudget,
  getCompletedRoomsForProject,
} from '@/lib/services/brainstorm-service';

import {
  DEMO_BRAINSTORM_ROOM,
  DEMO_BRAINSTORM_PARTICIPANTS,
  DEMO_BRAINSTORM_ROOM_ID,
  DEMO_PARTICIPANT_CLAUDE_ID,
  DEMO_PARTICIPANT_CODEX_ID,
  DEMO_PARTICIPANT_GEMINI_ID,
} from '@/lib/services/brainstorm-service.demo';

// ---------------------------------------------------------------------------
// Canonical IDs
// ---------------------------------------------------------------------------

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';
const GEMINI_AGENT_ID = '33333333-3333-4333-a333-333333333333';
const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';
const AGENDO_PROJECT_ID = '44444444-4444-4444-a444-444444444444';

describe('brainstorm-service (demo mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Fixture shape -------------------------------------------------------

  describe('demo fixtures', () => {
    it('DEMO_BRAINSTORM_ROOM has correct id and status', () => {
      expect(DEMO_BRAINSTORM_ROOM.id).toBe(DEMO_BRAINSTORM_ROOM_ID);
      expect(DEMO_BRAINSTORM_ROOM.status).toBe('ended');
    });

    it('DEMO_BRAINSTORM_ROOM has correct title and synthesis', () => {
      expect(DEMO_BRAINSTORM_ROOM.title).toBe('Design session reconnect strategy');
      expect(typeof DEMO_BRAINSTORM_ROOM.synthesis).toBe('string');
      expect(DEMO_BRAINSTORM_ROOM.synthesis!.length).toBeGreaterThan(10);
    });

    it('DEMO_BRAINSTORM_ROOM has 3 waves completed', () => {
      expect(DEMO_BRAINSTORM_ROOM.currentWave).toBe(3);
    });

    it('DEMO_BRAINSTORM_ROOM projectId is agendo project', () => {
      expect(DEMO_BRAINSTORM_ROOM.projectId).toBe(AGENDO_PROJECT_ID);
    });

    it('DEMO_BRAINSTORM_ROOM required non-nullable fields', () => {
      expect(DEMO_BRAINSTORM_ROOM.id).toBeTruthy();
      expect(DEMO_BRAINSTORM_ROOM.title).toBeTruthy();
      expect(DEMO_BRAINSTORM_ROOM.topic).toBeTruthy();
      expect(DEMO_BRAINSTORM_ROOM.createdAt).toBeInstanceOf(Date);
      expect(DEMO_BRAINSTORM_ROOM.updatedAt).toBeInstanceOf(Date);
      expect(typeof DEMO_BRAINSTORM_ROOM.currentWave).toBe('number');
      expect(typeof DEMO_BRAINSTORM_ROOM.maxWaves).toBe('number');
    });

    it('DEMO_BRAINSTORM_PARTICIPANTS has 3 entries (Claude, Codex, Gemini)', () => {
      expect(DEMO_BRAINSTORM_PARTICIPANTS).toHaveLength(3);
      const agentIds = DEMO_BRAINSTORM_PARTICIPANTS.map((p) => p.agentId);
      expect(agentIds).toContain(CLAUDE_AGENT_ID);
      expect(agentIds).toContain(CODEX_AGENT_ID);
      expect(agentIds).toContain(GEMINI_AGENT_ID);
    });

    it('DEMO_BRAINSTORM_PARTICIPANTS each have required fields', () => {
      for (const p of DEMO_BRAINSTORM_PARTICIPANTS) {
        expect(p.id).toBeTruthy();
        expect(p.roomId).toBe(DEMO_BRAINSTORM_ROOM_ID);
        expect(p.agentId).toBeTruthy();
        expect(p.status).toBe('active');
        expect(p.joinedAt).toBeInstanceOf(Date);
      }
    });
  });

  // ---- Read functions -------------------------------------------------------

  describe('getBrainstorm', () => {
    it('returns demo room with participants for known id', async () => {
      const room = await getBrainstorm(DEMO_BRAINSTORM_ROOM_ID);
      expect(room.id).toBe(DEMO_BRAINSTORM_ROOM_ID);
      expect(room.status).toBe('ended');
      expect(Array.isArray(room.participants)).toBe(true);
      expect(room.participants).toHaveLength(3);
    });

    it('returns project details', async () => {
      const room = await getBrainstorm(DEMO_BRAINSTORM_ROOM_ID);
      expect(room.project).not.toBeNull();
      expect(room.project!.id).toBe(AGENDO_PROJECT_ID);
      expect(typeof room.project!.name).toBe('string');
    });

    it('participants include agentName and agentSlug', async () => {
      const room = await getBrainstorm(DEMO_BRAINSTORM_ROOM_ID);
      for (const p of room.participants) {
        expect(typeof p.agentName).toBe('string');
        expect(p.agentName.length).toBeGreaterThan(0);
        expect(typeof p.agentSlug).toBe('string');
        expect(typeof p.agentBinaryPath).toBe('string');
      }
    });

    it('throws for unknown id in demo mode', async () => {
      await expect(getBrainstorm('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });
  });

  describe('listBrainstorms', () => {
    it('returns all demo rooms when no filter', async () => {
      const rooms = await listBrainstorms();
      expect(rooms.length).toBeGreaterThan(0);
    });

    it('filters by projectId', async () => {
      const rooms = await listBrainstorms({ projectId: AGENDO_PROJECT_ID });
      expect(rooms.every((r) => r.projectId === AGENDO_PROJECT_ID)).toBe(true);
    });

    it('filters by status ended', async () => {
      const rooms = await listBrainstorms({ status: 'ended' });
      expect(rooms.every((r) => r.status === 'ended')).toBe(true);
    });

    it('returns BrainstormRoomSummary shape with participantCount', async () => {
      const rooms = await listBrainstorms();
      for (const r of rooms) {
        expect(typeof r.id).toBe('string');
        expect(typeof r.title).toBe('string');
        expect(typeof r.status).toBe('string');
        expect(typeof r.participantCount).toBe('number');
        expect(r.createdAt).toBeInstanceOf(Date);
        expect(r.updatedAt).toBeInstanceOf(Date);
      }
    });

    it('returns empty array for unknown projectId', async () => {
      const rooms = await listBrainstorms({ projectId: '00000000-0000-0000-0000-000000000099' });
      expect(rooms).toHaveLength(0);
    });
  });

  describe('getCompletedRoomsForProject', () => {
    it('returns rooms for agendo project that have synthesis', async () => {
      const rooms = await getCompletedRoomsForProject(AGENDO_PROJECT_ID);
      expect(rooms.length).toBeGreaterThan(0);
      for (const r of rooms) {
        expect(typeof r.synthesis).toBe('string');
        expect(r.synthesis.length).toBeGreaterThan(0);
      }
    });

    it('returns empty for unknown project', async () => {
      const rooms = await getCompletedRoomsForProject('00000000-0000-0000-0000-000000000099');
      expect(rooms).toHaveLength(0);
    });
  });

  describe('getParticipantBySessionId', () => {
    it('returns participant for known session id', async () => {
      const participant = await getParticipantBySessionId(CLAUDE_SESSION_ID);
      expect(participant).not.toBeNull();
      expect(participant!.agentId).toBe(CLAUDE_AGENT_ID);
      expect(typeof participant!.agentName).toBe('string');
      expect(typeof participant!.agentSlug).toBe('string');
    });

    it('returns null for unknown session id', async () => {
      const participant = await getParticipantBySessionId('00000000-0000-0000-0000-000000000099');
      expect(participant).toBeNull();
    });
  });

  // ---- Mutation stubs -------------------------------------------------------

  describe('createBrainstorm (demo stub)', () => {
    it('returns a brainstorm room stub without hitting DB', async () => {
      const result = await createBrainstorm({
        projectId: AGENDO_PROJECT_ID,
        title: 'Test brainstorm',
        topic: 'Test topic',
        participants: [{ agentId: CLAUDE_AGENT_ID }, { agentId: CODEX_AGENT_ID }],
      });
      expect(result.id).toBeTruthy();
      expect(result.title).toBe('Test brainstorm');
      expect(result.status).toBe('waiting');
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('updateBrainstormStatus (demo stub)', () => {
    it('returns updated stub with new status', async () => {
      const result = await updateBrainstormStatus(DEMO_BRAINSTORM_ROOM_ID, 'active');
      expect(result.id).toBe(DEMO_BRAINSTORM_ROOM_ID);
      expect(result.status).toBe('active');
    });

    it('returns updated stub for unknown id (no throw in demo)', async () => {
      const result = await updateBrainstormStatus('00000000-0000-0000-0000-000000000099', 'paused');
      expect(result.status).toBe('paused');
    });
  });

  describe('updateBrainstormWave (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(updateBrainstormWave(DEMO_BRAINSTORM_ROOM_ID, 4)).resolves.toBeUndefined();
    });
  });

  describe('updateBrainstormMaxWaves (demo stub)', () => {
    it('returns updated stub with new maxWaves', async () => {
      const result = await updateBrainstormMaxWaves(DEMO_BRAINSTORM_ROOM_ID, 15);
      expect(result.id).toBe(DEMO_BRAINSTORM_ROOM_ID);
      expect(result.maxWaves).toBe(15);
    });
  });

  describe('setBrainstormSynthesis (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        setBrainstormSynthesis(DEMO_BRAINSTORM_ROOM_ID, 'Updated synthesis'),
      ).resolves.toBeUndefined();
    });
  });

  describe('setBrainstormOutcome (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        setBrainstormOutcome(DEMO_BRAINSTORM_ROOM_ID, {
          endState: 'converged',
          totalWaves: 3,
          totalParticipants: 3,
          activeParticipantsAtEnd: 3,
          evictedCount: 0,
          timeoutCount: 0,
          synthesisParseSuccess: true,
          taskCreationCount: 0,
          totalDurationMs: 900000,
          convergenceWave: 3,
          reflectionWavesTriggered: 0,
          deliverableType: 'decision',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('addParticipant (demo stub)', () => {
    it('returns a participant stub', async () => {
      const result = await addParticipant(
        DEMO_BRAINSTORM_ROOM_ID,
        CLAUDE_AGENT_ID,
        'claude-3-5-sonnet',
      );
      expect(result.id).toBeTruthy();
      expect(result.roomId).toBe(DEMO_BRAINSTORM_ROOM_ID);
      expect(result.agentId).toBe(CLAUDE_AGENT_ID);
      expect(result.joinedAt).toBeInstanceOf(Date);
    });
  });

  describe('removeParticipant (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        removeParticipant(DEMO_BRAINSTORM_ROOM_ID, DEMO_PARTICIPANT_CLAUDE_ID),
      ).resolves.toBeUndefined();
    });
  });

  describe('updateParticipantSession (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        updateParticipantSession(DEMO_PARTICIPANT_CLAUDE_ID, CLAUDE_SESSION_ID),
      ).resolves.toBeUndefined();
    });
  });

  describe('updateParticipantModel (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        updateParticipantModel(DEMO_PARTICIPANT_CODEX_ID, 'codex-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('updateParticipantAgent (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        updateParticipantAgent(DEMO_PARTICIPANT_GEMINI_ID, GEMINI_AGENT_ID),
      ).resolves.toBeUndefined();
    });
  });

  describe('updateParticipantStatus (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        updateParticipantStatus(DEMO_PARTICIPANT_CLAUDE_ID, 'passed'),
      ).resolves.toBeUndefined();
    });
  });

  describe('updateParticipantRole (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        updateParticipantRole(DEMO_PARTICIPANT_CLAUDE_ID, 'architect'),
      ).resolves.toBeUndefined();
    });
  });

  describe('updateBrainstormLogPath (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(
        updateBrainstormLogPath(DEMO_BRAINSTORM_ROOM_ID, '/data/agendo/logs/demo-brainstorm.jsonl'),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteBrainstorm (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(deleteBrainstorm(DEMO_BRAINSTORM_ROOM_ID)).resolves.toBeUndefined();
    });
  });

  describe('extendBrainstorm (demo stub)', () => {
    it('returns a room stub with increased maxWaves', async () => {
      const result = await extendBrainstorm(DEMO_BRAINSTORM_ROOM_ID, 5);
      expect(result.id).toBe(DEMO_BRAINSTORM_ROOM_ID);
      expect(result.maxWaves).toBeGreaterThan(DEMO_BRAINSTORM_ROOM.maxWaves);
    });
  });

  describe('addWaveBudget (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(addWaveBudget(DEMO_BRAINSTORM_ROOM_ID, 3)).resolves.toBeUndefined();
    });
  });
});
