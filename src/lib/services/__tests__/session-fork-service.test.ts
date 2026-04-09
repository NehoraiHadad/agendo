import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock state — all hoisted so vi.mock factories can reference them
// ---------------------------------------------------------------------------
const {
  mockState,
  mockGetSession,
  mockCreateAndEnqueueSession,
  mockExtractSessionContext,
  mockResolveSessionRuntimeContext,
} = vi.hoisted(() => ({
  mockState: {
    /** db.select() sequence: each call shifts from this queue */
    selectQueue: [] as Array<unknown[]>,
  },
  mockGetSession: vi.fn(),
  mockCreateAndEnqueueSession: vi.fn(),
  mockExtractSessionContext: vi.fn(),
  mockResolveSessionRuntimeContext: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @/lib/db
// Each db.select() call returns the next item from mockState.selectQueue.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => {
  const makeChain = (result: unknown[]) =>
    Object.assign(Promise.resolve(result), {
      where: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(result), {
          limit: vi.fn().mockResolvedValue(result),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(result),
          }),
        }),
      ),
      limit: vi.fn().mockResolvedValue(result),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    });

  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const result = mockState.selectQueue.shift() ?? [];
        return { from: vi.fn().mockReturnValue(makeChain(result)) };
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock @/lib/services/session-service
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/session-service', () => ({
  getSession: mockGetSession,
}));

// ---------------------------------------------------------------------------
// Mock @/lib/services/session-helpers
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/session-helpers', () => ({
  createAndEnqueueSession: mockCreateAndEnqueueSession,
}));

// ---------------------------------------------------------------------------
// Mock @/lib/services/context-extractor
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/context-extractor', () => ({
  extractSessionContext: mockExtractSessionContext,
}));

// ---------------------------------------------------------------------------
// Mock @/lib/services/session-runtime-context
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/session-runtime-context', () => ({
  resolveSessionRuntimeContext: mockResolveSessionRuntimeContext,
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are set up
// ---------------------------------------------------------------------------
import { forkSessionToAgent } from '../session-fork-service';
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARENT_SESSION_ID = '11111111-1111-1111-1111-111111111111';
const NEW_AGENT_ID = '22222222-2222-2222-2222-222222222222';
const CLAUDE_AGENT_ID = '33333333-3333-3333-3333-333333333333';
const NEW_SESSION_ID = '55555555-5555-5555-5555-555555555555';
const TASK_ID = '66666666-6666-6666-6666-666666666666';
const PROJECT_ID = '77777777-7777-7777-7777-777777777777';

const mockParent = {
  id: PARENT_SESSION_ID,
  agentId: CLAUDE_AGENT_ID,
  taskId: TASK_ID,
  projectId: PROJECT_ID,
  status: 'awaiting_input',
  kind: 'conversation',
  permissionMode: 'bypassPermissions',
  allowedTools: ['Bash', 'Edit'],
  idleTimeoutSec: 600,
  model: 'claude-sonnet-4-6',
  logFilePath: '/data/logs/session.log',
  sessionRef: 'claude-ref-123',
  parentSessionId: null,
  title: null,
  initialPrompt: 'Fix the login bug',
  workerId: null,
  heartbeatAt: null,
  startedAt: null,
  endedAt: null,
  planFilePath: null,
  planContent: null,
  forkSourceRef: null,
  resumeSessionAt: null,
  effort: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockExtracted = {
  prompt: '## Context from previous session\nThe agent worked on the login bug.',
  meta: {
    totalTurns: 5,
    includedVerbatimTurns: 3,
    summarizedTurns: 2,
    estimatedTokens: 800,
    previousAgent: 'Claude Code',
    taskTitle: 'Fix login bug',
    projectName: 'agendo',
  },
};

const mockNewAgent = { id: NEW_AGENT_ID, name: 'Gemini CLI' };

const mockNewSession = {
  id: NEW_SESSION_ID,
  agentId: NEW_AGENT_ID,
  taskId: TASK_ID,
  projectId: PROJECT_ID,
  status: 'idle',
  kind: 'conversation',
  permissionMode: 'bypassPermissions',
  allowedTools: ['Bash', 'Edit'],
  idleTimeoutSec: 600,
  model: null,
  parentSessionId: PARENT_SESSION_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Queues the DB select results for a happy-path fork:
 * 1. new agent lookup → [newAgent] or []
 */
function queueDbSelectResults(newAgent: unknown | null): void {
  mockState.selectQueue = [newAgent ? [newAgent] : []];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('forkSessionToAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.selectQueue = [];

    // Default happy-path stubs
    mockGetSession.mockResolvedValue(mockParent);
    mockCreateAndEnqueueSession.mockResolvedValue(mockNewSession);
    mockExtractSessionContext.mockResolvedValue(mockExtracted);
    // Default: parent resolved to a real project dir (not /tmp)
    mockResolveSessionRuntimeContext.mockResolvedValue({
      cwd: '/home/ubuntu/projects/agendo',
      session: mockParent,
      agent: { id: '33333333-3333-3333-3333-333333333333', workingDir: null },
      task: null,
      project: null,
      resolvedProjectId: null,
      envOverrides: {},
    });
  });

  describe('happy path — hybrid mode', () => {
    it('creates and dispatches session with correct fields, and returns contextMeta', async () => {
      queueDbSelectResults(mockNewAgent);

      const result = await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'hybrid',
      });

      // Verify getSession called with parent id
      expect(mockGetSession).toHaveBeenCalledWith(PARENT_SESSION_ID);

      // Verify extractSessionContext called with hybrid mode
      expect(mockExtractSessionContext).toHaveBeenCalledWith(PARENT_SESSION_ID, {
        mode: 'hybrid',
      });

      // Verify createAndEnqueueSession receives correct inherited fields and
      // enqueueOpts carries the context as resumePrompt to the worker
      expect(mockCreateAndEnqueueSession).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          kind: 'conversation',
          agentId: NEW_AGENT_ID,
          permissionMode: 'bypassPermissions',
          allowedTools: ['Bash', 'Edit'],
          idleTimeoutSec: 600,
          parentSessionId: PARENT_SESSION_ID,
          initialPrompt: mockExtracted.prompt,
          enqueueOpts: { resumePrompt: mockExtracted.prompt },
        }),
      );

      // Verify return shape
      expect(result.session).toBe(mockNewSession);
      expect(result.agentName).toBe('Gemini CLI');
      expect(result.contextMeta).toEqual(mockExtracted.meta);
    });
  });

  describe('happy path — full mode', () => {
    it('passes contextMode="full" to extractSessionContext', async () => {
      queueDbSelectResults(mockNewAgent);

      await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'full',
      });

      expect(mockExtractSessionContext).toHaveBeenCalledWith(PARENT_SESSION_ID, {
        mode: 'full',
      });
    });
  });

  describe('additional instructions', () => {
    it('appends additionalInstructions to the extracted prompt', async () => {
      queueDbSelectResults(mockNewAgent);

      await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'hybrid',
        additionalInstructions: 'Focus on the OAuth flow only.',
      });

      const createArg = mockCreateAndEnqueueSession.mock.calls[0][0] as {
        initialPrompt: string;
        enqueueOpts: { resumePrompt: string };
      };
      expect(createArg.initialPrompt).toContain(mockExtracted.prompt);
      expect(createArg.initialPrompt).toContain('Additional instructions:');
      expect(createArg.initialPrompt).toContain('Focus on the OAuth flow only.');
      // enqueueOpts.resumePrompt must also contain the instructions
      expect(createArg.enqueueOpts.resumePrompt).toContain('Focus on the OAuth flow only.');
    });
  });

  describe('field inheritance', () => {
    it('copies taskId, projectId, permissionMode, allowedTools, idleTimeoutSec from parent', async () => {
      queueDbSelectResults(mockNewAgent);

      await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'hybrid',
      });

      const createArg = mockCreateAndEnqueueSession.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg['taskId']).toBe(TASK_ID);
      expect(createArg['projectId']).toBe(PROJECT_ID);
      expect(createArg['permissionMode']).toBe('bypassPermissions');
      expect(createArg['allowedTools']).toEqual(['Bash', 'Edit']);
      expect(createArg['idleTimeoutSec']).toBe(600);
    });

    it('does NOT copy model (agent-specific)', async () => {
      queueDbSelectResults(mockNewAgent);

      await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'hybrid',
      });

      const createArg = mockCreateAndEnqueueSession.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg['model']).toBeUndefined();
    });

    it('does NOT set forkSourceRef (cross-agent cannot resume parent history)', async () => {
      queueDbSelectResults(mockNewAgent);

      await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'hybrid',
      });

      const createArg = mockCreateAndEnqueueSession.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg['forkSourceRef']).toBeUndefined();
    });

    it('passes spawnCwd when parent resolved to a real directory (not /tmp)', async () => {
      mockResolveSessionRuntimeContext.mockResolvedValue({
        cwd: '/home/ubuntu/projects/agendo',
        session: mockParent,
        agent: {},
        task: null,
        project: null,
        resolvedProjectId: null,
        envOverrides: {},
      });
      queueDbSelectResults(mockNewAgent);

      await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'hybrid',
      });

      const createArg = mockCreateAndEnqueueSession.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg['spawnCwd']).toBe('/home/ubuntu/projects/agendo');
    });

    it('does NOT pass spawnCwd when parent resolved to /tmp (default fallback)', async () => {
      mockResolveSessionRuntimeContext.mockResolvedValue({
        cwd: '/tmp',
        session: mockParent,
        agent: {},
        task: null,
        project: null,
        resolvedProjectId: null,
        envOverrides: {},
      });
      queueDbSelectResults(mockNewAgent);

      await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'hybrid',
      });

      const createArg = mockCreateAndEnqueueSession.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg['spawnCwd']).toBeUndefined();
    });
  });

  describe('validation — same-agent rejection', () => {
    it('throws BadRequestError when newAgentId equals parent.agentId', async () => {
      await expect(
        forkSessionToAgent({
          parentSessionId: PARENT_SESSION_ID,
          newAgentId: CLAUDE_AGENT_ID, // same as mockParent.agentId
          contextMode: 'hybrid',
        }),
      ).rejects.toThrow(BadRequestError);

      // Ensure nothing was created or enqueued
      expect(mockCreateAndEnqueueSession).not.toHaveBeenCalled();
    });
  });

  describe('validation — invalid parent status', () => {
    it('throws ConflictError when parent status is "ended"', async () => {
      mockGetSession.mockResolvedValue({ ...mockParent, status: 'ended' });

      await expect(
        forkSessionToAgent({
          parentSessionId: PARENT_SESSION_ID,
          newAgentId: NEW_AGENT_ID,
          contextMode: 'hybrid',
        }),
      ).rejects.toThrow(ConflictError);

      expect(mockCreateAndEnqueueSession).not.toHaveBeenCalled();
    });

    it('does NOT throw for valid fork state "idle" (Agendo idle-timeout suspends to idle)', async () => {
      // Sessions suspended by Agendo's idle-timeout land in 'idle', not 'ended'.
      // They have a full conversation log and should be fork-able.
      mockGetSession.mockResolvedValue({ ...mockParent, status: 'idle' });
      queueDbSelectResults(mockNewAgent);

      await expect(
        forkSessionToAgent({
          parentSessionId: PARENT_SESSION_ID,
          newAgentId: NEW_AGENT_ID,
          contextMode: 'hybrid',
        }),
      ).resolves.toBeDefined();
    });

    it('does NOT throw for valid fork state "active"', async () => {
      mockGetSession.mockResolvedValue({ ...mockParent, status: 'active' });
      queueDbSelectResults(mockNewAgent);

      await expect(
        forkSessionToAgent({
          parentSessionId: PARENT_SESSION_ID,
          newAgentId: NEW_AGENT_ID,
          contextMode: 'hybrid',
        }),
      ).resolves.toBeDefined();
    });

    it('does NOT throw for valid fork state "awaiting_input"', async () => {
      // mockParent already has status: 'awaiting_input'
      queueDbSelectResults(mockNewAgent);

      await expect(
        forkSessionToAgent({
          parentSessionId: PARENT_SESSION_ID,
          newAgentId: NEW_AGENT_ID,
          contextMode: 'hybrid',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('validation — unknown new agent', () => {
    it('throws NotFoundError when newAgentId does not exist in DB', async () => {
      queueDbSelectResults(null /* no agent */);

      await expect(
        forkSessionToAgent({
          parentSessionId: PARENT_SESSION_ID,
          newAgentId: NEW_AGENT_ID,
          contextMode: 'hybrid',
        }),
      ).rejects.toThrow(NotFoundError);

      expect(mockCreateAndEnqueueSession).not.toHaveBeenCalled();
    });
  });

  describe('missing log file', () => {
    it('proceeds gracefully when extractor returns empty context (no log file)', async () => {
      const emptyExtracted = {
        prompt: '## Conversation Context Transfer\n\n*(No conversation history available.)*',
        meta: {
          totalTurns: 0,
          includedVerbatimTurns: 0,
          summarizedTurns: 0,
          estimatedTokens: 50,
          previousAgent: 'Claude Code',
        },
      };
      mockExtractSessionContext.mockResolvedValue(emptyExtracted);
      queueDbSelectResults(mockNewAgent);

      const result = await forkSessionToAgent({
        parentSessionId: PARENT_SESSION_ID,
        newAgentId: NEW_AGENT_ID,
        contextMode: 'hybrid',
      });

      // Should succeed and dispatch even for empty context (agent gets the empty-context prompt)
      expect(mockCreateAndEnqueueSession).toHaveBeenCalledWith(
        expect.objectContaining({
          enqueueOpts: { resumePrompt: emptyExtracted.prompt },
        }),
      );
      expect(result.contextMeta.totalTurns).toBe(0);
    });
  });
});
