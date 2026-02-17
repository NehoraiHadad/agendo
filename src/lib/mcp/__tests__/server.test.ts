import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiCall,
  resolveAgentSlug,
  parsePriority,
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handleCreateSubtask,
  handleAssignTask,
} from '../server';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockApiResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => ({ data }),
  });
}

function mockApiError(message: string, status = 400) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: 'Bad Request',
    json: async () => ({ error: { message } }),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parsePriority
// ---------------------------------------------------------------------------

describe('parsePriority', () => {
  it('returns undefined for undefined input', () => {
    expect(parsePriority(undefined)).toBeUndefined();
  });

  it('passes through numeric values', () => {
    expect(parsePriority(3)).toBe(3);
  });

  it('parses numeric strings', () => {
    expect(parsePriority('4')).toBe(4);
  });

  it('maps named priorities', () => {
    expect(parsePriority('lowest')).toBe(1);
    expect(parsePriority('low')).toBe(2);
    expect(parsePriority('medium')).toBe(3);
    expect(parsePriority('high')).toBe(4);
    expect(parsePriority('highest')).toBe(5);
    expect(parsePriority('critical')).toBe(5);
  });

  it('handles case insensitivity', () => {
    expect(parsePriority('HIGH')).toBe(4);
    expect(parsePriority('Medium')).toBe(3);
  });

  it('returns undefined for unknown strings', () => {
    expect(parsePriority('unknown')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// apiCall
// ---------------------------------------------------------------------------

describe('apiCall', () => {
  it('calls GET with correct URL', async () => {
    mockApiResponse([{ id: '1' }]);

    const result = await apiCall('/api/tasks');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tasks'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual([{ id: '1' }]);
  });

  it('calls POST with JSON body', async () => {
    const taskData = { title: 'Test task' };
    mockApiResponse({ id: '1', title: 'Test task' }, 200);

    await apiCall('/api/tasks', { method: 'POST', body: taskData });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tasks'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(taskData),
      }),
    );
  });

  it('throws on API error with message', async () => {
    mockApiError('Validation failed');

    await expect(apiCall('/api/tasks')).rejects.toThrow('Validation failed');
  });

  it('throws with status text when no error message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    });

    await expect(apiCall('/api/tasks')).rejects.toThrow('API error 500: Internal Server Error');
  });
});

// ---------------------------------------------------------------------------
// resolveAgentSlug
// ---------------------------------------------------------------------------

describe('resolveAgentSlug', () => {
  it('returns agent ID for valid slug', async () => {
    mockApiResponse([{ id: 'agent-uuid-123', slug: 'claude-code' }]);

    const id = await resolveAgentSlug('claude-code');

    expect(id).toBe('agent-uuid-123');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/agents?slug=claude-code'),
      expect.anything(),
    );
  });

  it('throws when agent is not found (empty array)', async () => {
    mockApiResponse([]);

    await expect(resolveAgentSlug('nonexistent')).rejects.toThrow('Agent not found: nonexistent');
  });

  it('throws when agent data is undefined', async () => {
    mockApiResponse(undefined);

    await expect(resolveAgentSlug('nonexistent')).rejects.toThrow('Agent not found: nonexistent');
  });

  it('URL-encodes the slug', async () => {
    mockApiResponse([{ id: 'uuid' }]);

    await resolveAgentSlug('agent with spaces');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('slug=agent%20with%20spaces'),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// handleCreateTask
// ---------------------------------------------------------------------------

describe('handleCreateTask', () => {
  it('calls POST /api/tasks with correct body', async () => {
    mockApiResponse({ id: 'task-1', title: 'New task' });

    const result = await handleCreateTask({
      title: 'New task',
      description: 'A description',
      priority: 'high',
    });

    expect(result).toEqual({ id: 'task-1', title: 'New task' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body).toEqual({
      title: 'New task',
      description: 'A description',
      priority: 4,
    });
  });

  it('resolves assignee slug to UUID', async () => {
    // First call: resolve slug
    mockApiResponse([{ id: 'agent-uuid' }]);
    // Second call: create task
    mockApiResponse({ id: 'task-1' });

    await handleCreateTask({ title: 'Task', assignee: 'claude-code' });

    const createBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(createBody.assigneeAgentId).toBe('agent-uuid');
  });

  it('sends dueAt when provided', async () => {
    mockApiResponse({ id: 'task-1' });

    await handleCreateTask({
      title: 'Task',
      dueAt: '2026-03-01T00:00:00Z',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.dueAt).toBe('2026-03-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// handleUpdateTask
// ---------------------------------------------------------------------------

describe('handleUpdateTask', () => {
  it('calls PATCH /api/tasks/:id with only changed fields', async () => {
    mockApiResponse({ id: 'task-1', status: 'in_progress' });

    await handleUpdateTask({ taskId: 'task-1', status: 'in_progress' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tasks/task-1'),
      expect.objectContaining({ method: 'PATCH' }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body).toEqual({ status: 'in_progress' });
  });

  it('resolves assignee slug when updating', async () => {
    mockApiResponse([{ id: 'agent-uuid' }]);
    mockApiResponse({ id: 'task-1' });

    await handleUpdateTask({ taskId: 'task-1', assignee: 'gemini' });

    const patchBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(patchBody.assigneeAgentId).toBe('agent-uuid');
  });
});

// ---------------------------------------------------------------------------
// handleListTasks
// ---------------------------------------------------------------------------

describe('handleListTasks', () => {
  it('calls GET /api/tasks with query params', async () => {
    mockApiResponse([{ id: 'task-1' }, { id: 'task-2' }]);

    const result = await handleListTasks({ status: 'todo', limit: 50 });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tasks?status=todo&limit=50'),
      expect.anything(),
    );
    expect(result).toEqual([{ id: 'task-1' }, { id: 'task-2' }]);
  });

  it('defaults limit to 100', async () => {
    mockApiResponse([]);

    await handleListTasks({});

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('limit=100'), expect.anything());
  });

  it('filters by assignee client-side', async () => {
    // First call: list tasks
    mockApiResponse([
      { id: 'task-1', assigneeAgentId: 'agent-a' },
      { id: 'task-2', assigneeAgentId: 'agent-b' },
      { id: 'task-3', assigneeAgentId: 'agent-a' },
    ]);
    // Second call: resolve slug
    mockApiResponse([{ id: 'agent-a' }]);

    const result = await handleListTasks({ assignee: 'claude-code' });

    expect(result).toEqual([
      { id: 'task-1', assigneeAgentId: 'agent-a' },
      { id: 'task-3', assigneeAgentId: 'agent-a' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// handleCreateSubtask
// ---------------------------------------------------------------------------

describe('handleCreateSubtask', () => {
  it('includes parentTaskId in the request body', async () => {
    mockApiResponse({ id: 'subtask-1' });

    await handleCreateSubtask({
      parentTaskId: 'parent-uuid',
      title: 'Subtask',
      description: 'Subtask desc',
      priority: 2,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tasks'),
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.parentTaskId).toBe('parent-uuid');
    expect(body.title).toBe('Subtask');
    expect(body.description).toBe('Subtask desc');
    expect(body.priority).toBe(2);
  });

  it('resolves assignee for subtask', async () => {
    mockApiResponse([{ id: 'agent-uuid' }]);
    mockApiResponse({ id: 'subtask-1' });

    await handleCreateSubtask({
      parentTaskId: 'parent-uuid',
      title: 'Sub',
      assignee: 'codex',
    });

    const createBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(createBody.assigneeAgentId).toBe('agent-uuid');
    expect(createBody.parentTaskId).toBe('parent-uuid');
  });
});

// ---------------------------------------------------------------------------
// handleAssignTask
// ---------------------------------------------------------------------------

describe('handleAssignTask', () => {
  it('resolves slug and sends assigneeAgentId', async () => {
    mockApiResponse([{ id: 'agent-uuid' }]);
    mockApiResponse({ id: 'task-1', assigneeAgentId: 'agent-uuid' });

    const result = await handleAssignTask({
      taskId: 'task-1',
      assignee: 'claude-code',
    });

    // First call resolves slug
    expect(mockFetch.mock.calls[0][0]).toContain('/api/agents?slug=claude-code');

    // Second call patches task
    expect(mockFetch.mock.calls[1][0]).toContain('/api/tasks/task-1');
    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body).toEqual({ assigneeAgentId: 'agent-uuid' });
    expect(result).toEqual({ id: 'task-1', assigneeAgentId: 'agent-uuid' });
  });

  it('throws when agent slug is not found', async () => {
    mockApiResponse([]);

    await expect(handleAssignTask({ taskId: 'task-1', assignee: 'nonexistent' })).rejects.toThrow(
      'Agent not found: nonexistent',
    );
  });
});

// ---------------------------------------------------------------------------
// Error handling in tool handlers
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('handleCreateTask propagates API errors', async () => {
    mockApiError('Title is required');

    await expect(handleCreateTask({ title: '' })).rejects.toThrow('Title is required');
  });

  it('handleUpdateTask propagates not-found errors', async () => {
    mockApiError('Task not found', 404);

    await expect(handleUpdateTask({ taskId: 'missing', title: 'Updated' })).rejects.toThrow(
      'Task not found',
    );
  });
});
