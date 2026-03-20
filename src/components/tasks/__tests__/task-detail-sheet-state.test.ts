import { describe, expect, it } from 'vitest';
import type { Task } from '@/lib/types';
import { mergeTaskDetailSheetData, type TaskDetailSheetData } from '../task-detail-sheet-state';

function createDetails(overrides: Partial<TaskDetailSheetData> = {}): TaskDetailSheetData {
  return {
    id: 'task-1',
    title: 'Original title',
    description: 'Original description',
    status: 'todo',
    priority: 3,
    sortOrder: 1000,
    executionOrder: 2,
    parentTaskId: 'parent-1',
    assigneeAgentId: 'agent-1',
    projectId: 'project-1',
    inputContext: {},
    dueAt: '2025-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    subtaskCount: 4,
    completedSubtaskCount: 1,
    dependencyCount: 2,
    blockedByCount: 1,
    assignee: { id: 'agent-1', name: 'Agent One', slug: 'agent-one' },
    parentTask: { id: 'parent-1', title: 'Parent One' },
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    ownerId: '00000000-0000-0000-0000-000000000001',
    workspaceId: '00000000-0000-0000-0000-000000000001',
    title: 'Updated title',
    description: 'Updated description',
    status: 'in_progress',
    priority: 1,
    sortOrder: 2000,
    executionOrder: 5,
    parentTaskId: 'parent-1',
    assigneeAgentId: 'agent-1',
    projectId: 'project-2',
    inputContext: { promptAdditions: 'store' },
    dueAt: new Date('2025-02-03T00:00:00.000Z'),
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-02-04T00:00:00.000Z'),
    ...overrides,
  };
}

describe('mergeTaskDetailSheetData', () => {
  it('overlays task fields from the board store onto fetched detail data', () => {
    const merged = mergeTaskDetailSheetData(createDetails(), createTask());

    expect(merged).toMatchObject({
      title: 'Updated title',
      description: 'Updated description',
      status: 'in_progress',
      priority: 1,
      sortOrder: 2000,
      executionOrder: 5,
      projectId: 'project-2',
      dueAt: '2025-02-03T00:00:00.000Z',
      updatedAt: '2025-02-04T00:00:00.000Z',
      assignee: { id: 'agent-1', name: 'Agent One', slug: 'agent-one' },
      parentTask: { id: 'parent-1', title: 'Parent One' },
    });
    expect(merged?.subtaskCount).toBe(4);
  });

  it('clears stale relation objects when the referenced ids change in the store', () => {
    const merged = mergeTaskDetailSheetData(
      createDetails(),
      createTask({
        parentTaskId: null,
        assigneeAgentId: 'agent-2',
      }),
    );

    expect(merged?.parentTaskId).toBeNull();
    expect(merged?.parentTask).toBeNull();
    expect(merged?.assigneeAgentId).toBe('agent-2');
    expect(merged?.assignee).toBeNull();
  });

  it('returns fetched details unchanged when the task is not in the store yet', () => {
    const details = createDetails();
    expect(mergeTaskDetailSheetData(details, null)).toBe(details);
  });
});
