import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Mock shared.ts — apiCall is the primary dependency
const mockApiCall = vi.fn();
const mockResolveAgentSlug = vi.fn();

vi.mock('../shared.js', () => ({
  apiCall: (...args: unknown[]) => mockApiCall(...args),
  resolveAgentSlug: (...args: unknown[]) => mockResolveAgentSlug(...args),
  AGENT_NOTE: 'agent_note',
  wrapToolCall: async (fn: () => Promise<unknown>) => {
    try {
      const result = await fn();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
  resolveTaskId: (taskId?: string) => taskId ?? 'env-task-id',
}));

// Import after mocks
import {
  handleCreateTeam,
  handleSendTeamMessage,
  handleGetTeamStatus,
  handleGetTeammates,
  buildTeamContextMessage,
} from '../team-tools.js';

// Save env snapshot — tests that modify env restore in their own afterEach
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // Clear session ID to prevent team context broadcast in legacy tests.
  // Tests that need specific env vars set them explicitly.
  delete process.env.AGENDO_SESSION_ID;
  delete process.env.AGENDO_TASK_ID;
});

afterAll(() => {
  process.env = originalEnv;
});

// ---------------------------------------------------------------------------
// create_team
// ---------------------------------------------------------------------------

describe('handleCreateTeam', () => {
  it('creates subtasks and sessions for each member', async () => {
    const parentTaskId = 'parent-task-uuid';

    // Mock agent slug resolution
    mockResolveAgentSlug
      .mockResolvedValueOnce('claude-agent-uuid')
      .mockResolvedValueOnce('codex-agent-uuid');

    // Mock subtask creation (2 members)
    mockApiCall
      .mockResolvedValueOnce({ id: 'subtask-1-uuid', title: 'Backend work' }) // create subtask 1
      .mockResolvedValueOnce({ id: 'session-1-uuid' }) // create session 1
      .mockResolvedValueOnce({ id: 'subtask-2-uuid', title: 'Frontend work' }) // create subtask 2
      .mockResolvedValueOnce({ id: 'session-2-uuid' }); // create session 2

    const result = await handleCreateTeam({
      taskId: parentTaskId,
      members: [
        { agent: 'claude-code-1', role: 'Backend work', prompt: 'Implement API endpoints' },
        { agent: 'codex-cli-1', role: 'Frontend work', prompt: 'Build React components' },
      ],
    });

    // Verify subtask creation calls
    expect(mockApiCall).toHaveBeenCalledWith('/api/tasks', {
      method: 'POST',
      body: expect.objectContaining({
        title: 'Backend work',
        parentTaskId,
        assigneeAgentId: 'claude-agent-uuid',
      }),
    });
    expect(mockApiCall).toHaveBeenCalledWith('/api/tasks', {
      method: 'POST',
      body: expect.objectContaining({
        title: 'Frontend work',
        parentTaskId,
        assigneeAgentId: 'codex-agent-uuid',
      }),
    });

    // Verify session creation calls
    expect(mockApiCall).toHaveBeenCalledWith('/api/sessions', {
      method: 'POST',
      body: expect.objectContaining({
        taskId: 'subtask-1-uuid',
        agentId: 'claude-agent-uuid',
        initialPrompt: 'Implement API endpoints',
        permissionMode: 'bypassPermissions',
      }),
    });
    expect(mockApiCall).toHaveBeenCalledWith('/api/sessions', {
      method: 'POST',
      body: expect.objectContaining({
        taskId: 'subtask-2-uuid',
        agentId: 'codex-agent-uuid',
        initialPrompt: 'Build React components',
        permissionMode: 'bypassPermissions',
      }),
    });

    // Verify output
    expect(result).toEqual({
      teamId: parentTaskId,
      members: [
        {
          agent: 'claude-code-1',
          role: 'Backend work',
          subtaskId: 'subtask-1-uuid',
          sessionId: 'session-1-uuid',
        },
        {
          agent: 'codex-cli-1',
          role: 'Frontend work',
          subtaskId: 'subtask-2-uuid',
          sessionId: 'session-2-uuid',
        },
      ],
    });
  });

  it('passes custom permissionMode and model', async () => {
    mockResolveAgentSlug.mockResolvedValueOnce('agent-uuid');
    mockApiCall
      .mockResolvedValueOnce({ id: 'subtask-uuid' })
      .mockResolvedValueOnce({ id: 'session-uuid' });

    await handleCreateTeam({
      taskId: 'parent-uuid',
      members: [
        {
          agent: 'gemini-cli-1',
          role: 'Review',
          prompt: 'Review code',
          permissionMode: 'acceptEdits',
          model: 'gemini-2.5-pro',
        },
      ],
    });

    expect(mockApiCall).toHaveBeenCalledWith('/api/sessions', {
      method: 'POST',
      body: expect.objectContaining({
        permissionMode: 'acceptEdits',
        model: 'gemini-2.5-pro',
      }),
    });
  });

  it('requires at least one member', async () => {
    await expect(handleCreateTeam({ taskId: 'parent-uuid', members: [] })).rejects.toThrow(
      'At least one team member is required',
    );
  });
});

// ---------------------------------------------------------------------------
// send_team_message
// ---------------------------------------------------------------------------

describe('handleSendTeamMessage', () => {
  it('proxies message to session message API', async () => {
    mockApiCall.mockResolvedValueOnce({ delivered: true });

    const result = await handleSendTeamMessage({
      sessionId: 'session-uuid',
      message: 'Please focus on error handling',
    });

    expect(mockApiCall).toHaveBeenCalledWith('/api/sessions/session-uuid/message', {
      method: 'POST',
      body: { message: 'Please focus on error handling' },
    });
    expect(result).toEqual({ delivered: true });
  });
});

// ---------------------------------------------------------------------------
// get_team_status
// ---------------------------------------------------------------------------

describe('handleGetTeamStatus', () => {
  it('aggregates subtask statuses and session info', async () => {
    // Mock parent task
    mockApiCall.mockResolvedValueOnce({
      id: 'parent-uuid',
      title: 'Team Task',
      status: 'in_progress',
    });

    // Mock subtasks
    mockApiCall.mockResolvedValueOnce([
      {
        id: 'subtask-1',
        title: 'Backend',
        status: 'in_progress',
        assigneeAgentId: 'agent-1',
        assignee: { slug: 'claude-code-1' },
      },
      {
        id: 'subtask-2',
        title: 'Frontend',
        status: 'todo',
        assigneeAgentId: 'agent-2',
        assignee: { slug: 'codex-cli-1' },
      },
    ]);

    // Mock progress notes for subtask 1
    mockApiCall.mockResolvedValueOnce([
      { eventType: 'agent_note', payload: { note: 'API routes done' } },
    ]);
    // Mock sessions for subtask 1
    mockApiCall.mockResolvedValueOnce([{ id: 'session-1', status: 'active' }]);

    // Mock progress notes for subtask 2
    mockApiCall.mockResolvedValueOnce([]);
    // Mock sessions for subtask 2
    mockApiCall.mockResolvedValueOnce([{ id: 'session-2', status: 'awaiting_input' }]);

    const result = await handleGetTeamStatus({ taskId: 'parent-uuid' });

    expect(result).toEqual({
      taskId: 'parent-uuid',
      title: 'Team Task',
      status: 'in_progress',
      members: [
        {
          subtaskId: 'subtask-1',
          title: 'Backend',
          status: 'in_progress',
          assignee: 'claude-code-1',
          latestNote: 'API routes done',
          sessionId: 'session-1',
          sessionStatus: 'active',
        },
        {
          subtaskId: 'subtask-2',
          title: 'Frontend',
          status: 'todo',
          assignee: 'codex-cli-1',
          latestNote: null,
          sessionId: 'session-2',
          sessionStatus: 'awaiting_input',
        },
      ],
    });
  });

  it('handles subtasks with no sessions', async () => {
    mockApiCall.mockResolvedValueOnce({
      id: 'parent-uuid',
      title: 'Solo Task',
      status: 'todo',
    });
    mockApiCall.mockResolvedValueOnce([
      {
        id: 'subtask-1',
        title: 'Work',
        status: 'todo',
        assigneeAgentId: null,
        assignee: null,
      },
    ]);
    // Progress notes for subtask-1
    mockApiCall.mockResolvedValueOnce([]);
    // Sessions for subtask-1
    mockApiCall.mockResolvedValueOnce([]);

    const result = await handleGetTeamStatus({ taskId: 'parent-uuid' });

    expect(result).toEqual({
      taskId: 'parent-uuid',
      title: 'Solo Task',
      status: 'todo',
      members: [
        {
          subtaskId: 'subtask-1',
          title: 'Work',
          status: 'todo',
          assignee: null,
          latestNote: null,
          sessionId: null,
          sessionStatus: null,
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// create_team — team context broadcast
// ---------------------------------------------------------------------------

describe('handleCreateTeam — team context broadcast', () => {
  beforeEach(() => {
    process.env.AGENDO_SESSION_ID = 'lead-session-uuid';
  });

  it('sends team context message to each worker after creation', async () => {
    mockResolveAgentSlug
      .mockResolvedValueOnce('claude-agent-uuid')
      .mockResolvedValueOnce('codex-agent-uuid');

    mockApiCall
      .mockResolvedValueOnce({ id: 'subtask-1' }) // create subtask 1
      .mockResolvedValueOnce({ id: 'session-1' }) // create session 1
      .mockResolvedValueOnce({ id: 'subtask-2' }) // create subtask 2
      .mockResolvedValueOnce({ id: 'session-2' }) // create session 2
      .mockResolvedValueOnce({ delivered: true }) // team context to session-1
      .mockResolvedValueOnce({ delivered: true }); // team context to session-2

    await handleCreateTeam({
      taskId: 'parent-uuid',
      members: [
        { agent: 'claude-code-1', role: 'Backend', prompt: 'Do backend' },
        { agent: 'codex-cli-1', role: 'Frontend', prompt: 'Do frontend' },
      ],
    });

    // Should have sent team context messages (calls 5 and 6)
    const messageCalls = mockApiCall.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('/message'),
    );
    expect(messageCalls).toHaveLength(2);

    // Each message should contain teammate info
    const msg1Body = messageCalls[0][1].body.message as string;
    expect(msg1Body).toContain('Team Lead');
    expect(msg1Body).toContain('lead-session-uuid');
    expect(msg1Body).toContain('send_team_message');
    // Worker 1 should see worker 2 as teammate
    expect(msg1Body).toContain('Frontend');
    expect(msg1Body).toContain('session-2');

    const msg2Body = messageCalls[1][1].body.message as string;
    // Worker 2 should see worker 1 as teammate
    expect(msg2Body).toContain('Backend');
    expect(msg2Body).toContain('session-1');
  });

  it('skips team context broadcast when AGENDO_SESSION_ID is not set', async () => {
    delete process.env.AGENDO_SESSION_ID;

    mockResolveAgentSlug.mockResolvedValueOnce('agent-uuid');
    mockApiCall
      .mockResolvedValueOnce({ id: 'subtask-1' })
      .mockResolvedValueOnce({ id: 'session-1' });

    await handleCreateTeam({
      taskId: 'parent-uuid',
      members: [{ agent: 'claude-code-1', role: 'Work', prompt: 'Do it' }],
    });

    // Only 2 calls: create subtask + create session (no team context message)
    expect(mockApiCall).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// buildTeamContextMessage
// ---------------------------------------------------------------------------

describe('buildTeamContextMessage', () => {
  it('includes lead session ID and teammate info', () => {
    const msg = buildTeamContextMessage(
      'lead-session-123',
      [
        { agent: 'claude-code-1', role: 'Backend', subtaskId: 'st-1', sessionId: 'sess-1' },
        { agent: 'codex-cli-1', role: 'Frontend', subtaskId: 'st-2', sessionId: 'sess-2' },
      ],
      'sess-1', // current session
    );

    expect(msg).toContain('lead-session-123');
    expect(msg).toContain('send_team_message');
    // Should list the OTHER teammate (not self)
    expect(msg).toContain('Frontend');
    expect(msg).toContain('sess-2');
    expect(msg).toContain('codex-cli-1');
  });

  it('excludes self from teammates list', () => {
    const msg = buildTeamContextMessage(
      'lead-123',
      [
        { agent: 'claude-code-1', role: 'My Role', subtaskId: 'st-1', sessionId: 'sess-1' },
        { agent: 'codex-cli-1', role: 'Other', subtaskId: 'st-2', sessionId: 'sess-2' },
      ],
      'sess-1',
    );

    // Should NOT list own session as teammate
    expect(msg).not.toContain('My Role');
    expect(msg).toContain('Other');
  });

  it('handles single-member team (no siblings)', () => {
    const msg = buildTeamContextMessage(
      'lead-123',
      [{ agent: 'claude-code-1', role: 'Solo', subtaskId: 'st-1', sessionId: 'sess-1' }],
      'sess-1',
    );

    expect(msg).toContain('lead-123');
    expect(msg).toContain('send_team_message');
    // No teammates section or empty
    expect(msg).not.toContain('Teammates');
  });
});

// ---------------------------------------------------------------------------
// get_teammates
// ---------------------------------------------------------------------------

describe('handleGetTeammates', () => {
  beforeEach(() => {
    process.env.AGENDO_TASK_ID = 'my-subtask-id';
    process.env.AGENDO_SESSION_ID = 'my-session-id';
  });

  it('returns team roster for a worker', async () => {
    // 1. Get my task (has parentTaskId)
    mockApiCall.mockResolvedValueOnce({
      id: 'my-subtask-id',
      title: 'My Work',
      parentTaskId: 'parent-uuid',
    });

    // 2. Get parent task subtasks
    mockApiCall.mockResolvedValueOnce([
      {
        id: 'subtask-1',
        title: 'Backend',
        status: 'in_progress',
        assigneeAgentId: 'agent-1',
        assignee: { slug: 'claude-code-1' },
      },
      {
        id: 'subtask-2',
        title: 'Frontend',
        status: 'todo',
        assigneeAgentId: 'agent-2',
        assignee: { slug: 'codex-cli-1' },
      },
    ]);

    // 3. Get sessions for each subtask (to find sessionIds)
    mockApiCall.mockResolvedValueOnce([{ id: 'session-1', status: 'active' }]);
    mockApiCall.mockResolvedValueOnce([{ id: 'session-2', status: 'awaiting_input' }]);

    const result = await handleGetTeammates();

    expect(result).toEqual({
      parentTaskId: 'parent-uuid',
      mySessionId: 'my-session-id',
      teammates: [
        {
          subtaskId: 'subtask-1',
          role: 'Backend',
          agent: 'claude-code-1',
          sessionId: 'session-1',
          status: 'in_progress',
        },
        {
          subtaskId: 'subtask-2',
          role: 'Frontend',
          agent: 'codex-cli-1',
          sessionId: 'session-2',
          status: 'todo',
        },
      ],
    });
  });

  it('throws if task has no parent (not a team member)', async () => {
    mockApiCall.mockResolvedValueOnce({
      id: 'my-task-id',
      title: 'Solo Task',
      parentTaskId: null,
    });

    await expect(handleGetTeammates()).rejects.toThrow('not part of a team');
  });

  it('throws if AGENDO_TASK_ID is not set', async () => {
    delete process.env.AGENDO_TASK_ID;

    await expect(handleGetTeammates()).rejects.toThrow();
  });
});
