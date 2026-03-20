import type { Task, TaskInputContext } from '@/lib/types';

export interface TaskDetailSheetData {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  sortOrder: number;
  executionOrder: number | null;
  parentTaskId: string | null;
  assigneeAgentId: string | null;
  projectId: string | null;
  inputContext: TaskInputContext;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  subtaskCount: number;
  completedSubtaskCount: number;
  dependencyCount: number;
  blockedByCount: number;
  assignee: { id: string; name: string; slug: string } | null;
  parentTask: { id: string; title: string } | null;
}

function toIsoString(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function mergeTaskDetailSheetData(
  details: TaskDetailSheetData | null,
  storeTask: Task | null | undefined,
): TaskDetailSheetData | null {
  if (!details || !storeTask) return details;

  return {
    ...details,
    title: storeTask.title,
    description: storeTask.description,
    status: storeTask.status,
    priority: storeTask.priority,
    sortOrder: storeTask.sortOrder,
    executionOrder: storeTask.executionOrder ?? null,
    parentTaskId: storeTask.parentTaskId,
    assigneeAgentId: storeTask.assigneeAgentId,
    projectId: storeTask.projectId ?? null,
    inputContext: storeTask.inputContext,
    dueAt: toIsoString(storeTask.dueAt),
    updatedAt: toIsoString(storeTask.updatedAt) ?? details.updatedAt,
    assignee:
      storeTask.assigneeAgentId && details.assignee?.id === storeTask.assigneeAgentId
        ? details.assignee
        : null,
    parentTask:
      storeTask.parentTaskId && details.parentTask?.id === storeTask.parentTaskId
        ? details.parentTask
        : null,
  };
}
