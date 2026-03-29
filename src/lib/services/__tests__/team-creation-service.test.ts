import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockCreateTask, mockCreateSession, mockDispatchSession, mockSendMessage } = vi.hoisted(
  () => ({
    mockCreateTask: vi.fn(),
    mockCreateSession: vi.fn(),
    mockDispatchSession: vi.fn().mockResolvedValue(undefined),
    mockSendMessage: vi.fn().mockResolvedValue({ delivered: true }),
  }),
);

vi.mock('@/lib/services/task-service', () => ({
  createTask: mockCreateTask,
}));

vi.mock('@/lib/services/session-service', () => ({
  createSession: mockCreateSession,
}));

vi.mock('@/lib/services/session-dispatch', () => ({
  dispatchSession: mockDispatchSession,
}));

vi.mock('@/lib/services/team-message-service', () => ({
  sendTeamMessage: mockSendMessage,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createTeam, type TeamCreationRequest } from '../team-creation-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let taskCounter = 0;
let sessionCounter = 0;

function resetCounters(): void {
  taskCounter = 0;
  sessionCounter = 0;
  mockCreateTask.mockImplementation(async () => {
    taskCounter++;
    return { id: `task-${taskCounter}`, title: `subtask-${taskCounter}` };
  });
  mockCreateSession.mockImplementation(async () => {
    sessionCounter++;
    return { id: `session-${sessionCounter}`, status: 'idle' };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTeam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCounters();
  });

  const baseRequest: TeamCreationRequest = {
    mode: 'agent_led',
    leadSessionId: 'lead-session-1',
    teamName: 'Test Team',
    members: [
      { agentId: 'agent-1', role: 'Backend', prompt: 'Implement the API' },
      { agentId: 'agent-2', role: 'Frontend', prompt: 'Build the UI' },
    ],
    projectId: 'project-1',
    parentTaskId: 'parent-task-1',
  };

  it('creates subtasks for each member under the parent task', async () => {
    await createTeam(baseRequest);

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Backend',
        parentTaskId: 'parent-task-1',
        projectId: 'project-1',
      }),
    );
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Frontend',
        parentTaskId: 'parent-task-1',
        projectId: 'project-1',
      }),
    );
  });

  it('creates sessions with teamRole=member and delegationPolicy=forbid', async () => {
    await createTeam(baseRequest);

    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        teamRole: 'member',
        delegationPolicy: 'forbid',
      }),
    );
  });

  it('sets parentSessionId for agent_led mode', async () => {
    await createTeam(baseRequest);

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'lead-session-1',
      }),
    );
  });

  it('dispatches each member session', async () => {
    await createTeam(baseRequest);

    expect(mockDispatchSession).toHaveBeenCalledTimes(2);
    expect(mockDispatchSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
    );
    expect(mockDispatchSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-2' }),
    );
  });

  it('broadcasts team context in agent_led mode', async () => {
    await createTeam(baseRequest);

    // Should send a team context message to each member
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('does NOT broadcast team context in ui_led mode', async () => {
    await createTeam({ ...baseRequest, mode: 'ui_led', leadSessionId: undefined });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('returns team result with member details', async () => {
    const result = await createTeam(baseRequest);

    expect(result.parentTaskId).toBe('parent-task-1');
    expect(result.members).toHaveLength(2);
    expect(result.members[0]).toEqual(
      expect.objectContaining({
        role: 'Backend',
        subtaskId: 'task-1',
        sessionId: 'session-1',
      }),
    );
  });

  it('throws when agent_led mode has no leadSessionId', async () => {
    await expect(
      createTeam({ ...baseRequest, mode: 'agent_led', leadSessionId: undefined }),
    ).rejects.toThrow('leadSessionId is required');
  });

  it('throws when members array is empty', async () => {
    await expect(createTeam({ ...baseRequest, members: [] })).rejects.toThrow(
      'At least one team member is required',
    );
  });

  it('passes permissionMode and model to session creation', async () => {
    await createTeam({
      ...baseRequest,
      members: [
        {
          agentId: 'agent-1',
          role: 'Backend',
          prompt: 'Do stuff',
          permissionMode: 'acceptEdits',
          model: 'opus',
        },
      ],
    });

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: 'acceptEdits',
        model: 'opus',
      }),
    );
  });
});
