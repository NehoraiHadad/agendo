/**
 * Tests for forkSession() in session-service.ts
 *
 * Focused on the forkSourceRef fix: forkSourceRef must be set whenever the
 * parent has a sessionRef, regardless of whether resumeAt is provided.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const { mockGetById, mockDispatchSession } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockDispatchSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @/lib/db
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => {
  const returning = vi.fn();
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } };
});

// ---------------------------------------------------------------------------
// Mock getById (used inside getSession)
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/db-helpers', () => ({
  getById: mockGetById,
}));

// ---------------------------------------------------------------------------
// Mock session-dispatch
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/session-dispatch', () => ({
  dispatchSession: mockDispatchSession,
}));

// ---------------------------------------------------------------------------
// Mock other deps imported by session-service.ts
// ---------------------------------------------------------------------------
vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionControl: vi.fn().mockResolvedValue(undefined),
  sendSessionEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/api-handler', () => ({
  requireFound: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import SUT + db mock AFTER mock declarations
// ---------------------------------------------------------------------------
import { forkSession } from '../session-service';
import { db } from '@/lib/db';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FORK_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SESSION_REF = 'claude-session-ref-123';
const RESUME_AT_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const BASE_PARENT = {
  id: PARENT_ID,
  taskId: 'task-1',
  projectId: 'proj-1',
  kind: 'conversation',
  agentId: 'agent-1',
  idleTimeoutSec: 600,
  status: 'awaiting_input',
  permissionMode: 'bypassPermissions',
  allowedTools: ['Bash'],
  model: 'claude-opus-4-5',
  sessionRef: SESSION_REF,
  parentSessionId: null,
  initialPrompt: null,
  forkSourceRef: null,
  forkPointUuid: null,
  logFilePath: null,
  workerId: null,
  heartbeatAt: null,
  startedAt: null,
  endedAt: null,
  planFilePath: null,
  planContent: null,
  resumeSessionAt: null,
  effort: null,
  title: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeFork = (overrides: Record<string, unknown> = {}) => ({
  id: FORK_ID,
  taskId: BASE_PARENT.taskId,
  projectId: BASE_PARENT.projectId,
  kind: BASE_PARENT.kind,
  agentId: BASE_PARENT.agentId,
  status: 'idle',
  permissionMode: BASE_PARENT.permissionMode,
  allowedTools: BASE_PARENT.allowedTools,
  model: BASE_PARENT.model,
  sessionRef: null,
  parentSessionId: PARENT_ID,
  ...overrides,
});

// Helper to extract the values object passed to db.insert().values()
function getInsertedValues(): Record<string, unknown> {
  const insertMock = db.insert as ReturnType<typeof vi.fn>;
  const valuesMock = insertMock.mock.results[0].value.values as ReturnType<typeof vi.fn>;
  return valuesMock.mock.calls[0][0] as Record<string, unknown>;
}

// Helper to configure the db mock for the current test
function setupDbInsert(fork: Record<string, unknown> = makeFork()): void {
  const insertMock = db.insert as ReturnType<typeof vi.fn>;
  insertMock.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([fork]),
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('forkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(BASE_PARENT);
    mockDispatchSession.mockResolvedValue('job-id');
    setupDbInsert();
  });

  describe('forkSourceRef — the core fix', () => {
    it('sets forkSourceRef to parent.sessionRef when resumeAt IS provided', async () => {
      await forkSession(PARENT_ID, RESUME_AT_UUID, 'fix the bug');

      const insertValues = getInsertedValues();
      expect(insertValues['forkSourceRef']).toBe(SESSION_REF);
    });

    it('sets forkSourceRef to parent.sessionRef when resumeAt is NOT provided (Fork button)', async () => {
      await forkSession(PARENT_ID);

      const insertValues = getInsertedValues();
      expect(insertValues['forkSourceRef']).toBe(SESSION_REF);
    });

    it('sets forkSourceRef to null when parent has no sessionRef (session never ran)', async () => {
      mockGetById.mockResolvedValue({ ...BASE_PARENT, sessionRef: null });

      await forkSession(PARENT_ID);

      const insertValues = getInsertedValues();
      expect(insertValues['forkSourceRef']).toBeNull();
    });
  });

  describe('forkPointUuid', () => {
    it('sets forkPointUuid to resumeAt when provided', async () => {
      await forkSession(PARENT_ID, RESUME_AT_UUID, 'implement plan');

      const insertValues = getInsertedValues();
      expect(insertValues['forkPointUuid']).toBe(RESUME_AT_UUID);
    });

    it('sets forkPointUuid to null when resumeAt is not provided', async () => {
      await forkSession(PARENT_ID);

      const insertValues = getInsertedValues();
      expect(insertValues['forkPointUuid']).toBeNull();
    });
  });

  describe('auto-dispatch', () => {
    it('dispatches the fork when parent has sessionRef and initialPrompt is provided', async () => {
      await forkSession(PARENT_ID, RESUME_AT_UUID, 'do the work');

      expect(mockDispatchSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: FORK_ID,
          resumeSessionAt: RESUME_AT_UUID,
          resumePrompt: 'do the work',
        }),
      );
    });

    it('does NOT dispatch when no initialPrompt is provided (bare Fork button)', async () => {
      await forkSession(PARENT_ID);

      expect(mockDispatchSession).not.toHaveBeenCalled();
    });

    it('does NOT dispatch when parent has no sessionRef, even with initialPrompt', async () => {
      mockGetById.mockResolvedValue({ ...BASE_PARENT, sessionRef: null });

      await forkSession(PARENT_ID, undefined, 'start fresh');

      expect(mockDispatchSession).not.toHaveBeenCalled();
    });
  });

  describe('field inheritance', () => {
    it('copies core fields from parent to the fork', async () => {
      await forkSession(PARENT_ID);

      const insertValues = getInsertedValues();
      expect(insertValues['taskId']).toBe(BASE_PARENT.taskId);
      expect(insertValues['projectId']).toBe(BASE_PARENT.projectId);
      expect(insertValues['kind']).toBe(BASE_PARENT.kind);
      expect(insertValues['agentId']).toBe(BASE_PARENT.agentId);
      expect(insertValues['permissionMode']).toBe(BASE_PARENT.permissionMode);
      expect(insertValues['allowedTools']).toEqual(BASE_PARENT.allowedTools);
      expect(insertValues['parentSessionId']).toBe(PARENT_ID);
      expect(insertValues['status']).toBe('idle');
    });
  });
});
