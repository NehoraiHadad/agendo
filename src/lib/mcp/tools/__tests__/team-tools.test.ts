import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { handleCreateTeam, handleSendTeamMessage, handleGetTeamStatus } from '../team-tools.js';

beforeEach(() => {
  vi.clearAllMocks();
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
        { agent: 'claude-code-1', subtaskId: 'subtask-1-uuid', sessionId: 'session-1-uuid' },
        { agent: 'codex-cli-1', subtaskId: 'subtask-2-uuid', sessionId: 'session-2-uuid' },
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
