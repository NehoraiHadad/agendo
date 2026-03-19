'use server';

import { z } from 'zod';
import { createTask, updateTask, deleteTask } from '@/lib/services/task-service';
import { addDependency, removeDependency } from '@/lib/services/dependency-service';
import { taskStatusEnum } from '@/lib/db/schema';
import { withAction, withValidatedAction, type ActionResult } from './action-utils';

// --- Schemas ---

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  parentTaskId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  dueAt: z.coerce.date().optional(),
  projectId: z.string().uuid().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  executionOrder: z.number().int().min(1).nullable().optional(),
});

const dependencySchema = z.object({
  taskId: z.string().uuid(),
  dependsOnTaskId: z.string().uuid(),
});

// --- Actions ---

export const createTaskAction: (input: z.input<typeof createTaskSchema>) => Promise<ActionResult> =
  withValidatedAction(createTaskSchema, (validated) => createTask(validated));

const _updateTask = withValidatedAction(
  z.object({ id: z.string(), data: updateTaskSchema }),
  ({ id, data }) => updateTask(id, data),
);

export async function updateTaskAction(
  id: string,
  input: z.input<typeof updateTaskSchema>,
): Promise<ActionResult> {
  return _updateTask({ id, data: input });
}

export const deleteTaskAction: (id: string) => Promise<ActionResult> = withAction((id: string) =>
  deleteTask(id),
);

const _updateTaskStatus = withAction(({ id, status }: { id: string; status: string }) => {
  const validatedStatus = z.enum(taskStatusEnum.enumValues).parse(status);
  return updateTask(id, { status: validatedStatus });
});

export async function updateTaskStatusAction(id: string, status: string): Promise<ActionResult> {
  return _updateTaskStatus({ id, status });
}

const _assignAgent = withAction(({ taskId, agentId }: { taskId: string; agentId: string | null }) =>
  updateTask(taskId, { assigneeAgentId: agentId }),
);

export async function assignAgentAction(
  taskId: string,
  agentId: string | null,
): Promise<ActionResult> {
  return _assignAgent({ taskId, agentId });
}

export const addDependencyAction: (
  input: z.input<typeof dependencySchema>,
) => Promise<ActionResult> = withValidatedAction(dependencySchema, ({ taskId, dependsOnTaskId }) =>
  addDependency(taskId, dependsOnTaskId),
);

const _removeDependency = withAction(
  ({ taskId, dependsOnTaskId }: { taskId: string; dependsOnTaskId: string }) =>
    removeDependency(taskId, dependsOnTaskId),
);

export async function removeDependencyAction(
  taskId: string,
  dependsOnTaskId: string,
): Promise<ActionResult> {
  return _removeDependency({ taskId, dependsOnTaskId });
}
