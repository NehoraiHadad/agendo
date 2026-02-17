import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock the task service before importing the route
vi.mock('@/lib/services/task-service', () => ({
  reorderTask: vi.fn(),
}));

import { POST } from '../route';
import { reorderTask } from '@/lib/services/task-service';

const mockReorderTask = vi.mocked(reorderTask);

const mockTask = {
  id: '00000000-0000-0000-0000-000000000001',
  ownerId: '00000000-0000-0000-0000-000000000001',
  workspaceId: '00000000-0000-0000-0000-000000000001',
  parentTaskId: null,
  title: 'Test Task',
  description: null,
  status: 'todo' as const,
  priority: 3,
  sortOrder: 1500,
  assigneeAgentId: null,
  inputContext: {},
  dueAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRequest(
  body: unknown,
  id = '00000000-0000-0000-0000-000000000001',
): [NextRequest, { params: Promise<Record<string, string>> }] {
  const req = new NextRequest(`http://localhost/api/tasks/${id}/reorder`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const context = { params: Promise.resolve({ id }) };
  return [req, context];
}

describe('POST /api/tasks/[id]/reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validation', () => {
    it('returns 422 when body is missing required afterSortOrder field', async () => {
      const [req, ctx] = makeRequest({ beforeSortOrder: 2000 });

      const res = await POST(req, ctx);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 422 when body is missing required beforeSortOrder field', async () => {
      const [req, ctx] = makeRequest({ afterSortOrder: 1000 });

      const res = await POST(req, ctx);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 422 when body is completely empty', async () => {
      const [req, ctx] = makeRequest({});

      const res = await POST(req, ctx);

      expect(res.status).toBe(422);
    });

    it('returns 422 when status is not a valid TaskStatus enum value', async () => {
      const [req, ctx] = makeRequest({
        afterSortOrder: 1000,
        beforeSortOrder: 2000,
        status: 'invalid_status',
      });

      const res = await POST(req, ctx);

      expect(res.status).toBe(422);
    });
  });

  describe('successful reorder', () => {
    it('calls reorderTask with the correct task id and parsed body', async () => {
      mockReorderTask.mockResolvedValueOnce(mockTask);

      const taskId = '00000000-0000-0000-0000-000000000001';
      const [req, ctx] = makeRequest({ afterSortOrder: 1000, beforeSortOrder: 2000 }, taskId);

      await POST(req, ctx);

      expect(mockReorderTask).toHaveBeenCalledOnce();
      expect(mockReorderTask).toHaveBeenCalledWith(taskId, {
        status: undefined,
        afterSortOrder: 1000,
        beforeSortOrder: 2000,
      });
    });

    it('returns updated task in response body on success', async () => {
      mockReorderTask.mockResolvedValueOnce(mockTask);

      const [req, ctx] = makeRequest({ afterSortOrder: 1000, beforeSortOrder: 2000 });

      const res = await POST(req, ctx);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toMatchObject({ id: mockTask.id, sortOrder: mockTask.sortOrder });
    });

    it('passes status to reorderTask when status is provided', async () => {
      mockReorderTask.mockResolvedValueOnce({ ...mockTask, status: 'in_progress' });

      const taskId = '00000000-0000-0000-0000-000000000002';
      const [req, ctx] = makeRequest(
        { afterSortOrder: null, beforeSortOrder: 1000, status: 'in_progress' },
        taskId,
      );

      await POST(req, ctx);

      expect(mockReorderTask).toHaveBeenCalledWith(taskId, {
        status: 'in_progress',
        afterSortOrder: null,
        beforeSortOrder: 1000,
      });
    });

    it('accepts null for both sort order values (first item in column)', async () => {
      mockReorderTask.mockResolvedValueOnce(mockTask);

      const [req, ctx] = makeRequest({ afterSortOrder: null, beforeSortOrder: null });

      const res = await POST(req, ctx);

      expect(res.status).toBe(200);
      expect(mockReorderTask).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ afterSortOrder: null, beforeSortOrder: null }),
      );
    });
  });
});
