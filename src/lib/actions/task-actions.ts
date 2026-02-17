'use server';

import { z } from 'zod';
import { createTask, updateTask, deleteTask } from '@/lib/services/task-service';
import { addDependency, removeDependency } from '@/lib/services/dependency-service';
import { taskStatusEnum } from '@/lib/db/schema';

// --- Schemas ---

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  parentTaskId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  dueAt: z.coerce.date().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

const dependencySchema = z.object({
  taskId: z.string().uuid(),
  dependsOnTaskId: z.string().uuid(),
});

// --- Actions ---

type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

export async function createTaskAction(
  input: z.input<typeof createTaskSchema>,
): Promise<ActionResult> {
  try {
    const validated = createTaskSchema.parse(input);
    const task = await createTask(validated);
    return { success: true, data: task };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create task',
    };
  }
}

export async function updateTaskAction(
  id: string,
  input: z.input<typeof updateTaskSchema>,
): Promise<ActionResult> {
  try {
    const validated = updateTaskSchema.parse(input);
    const task = await updateTask(id, validated);
    return { success: true, data: task };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update task',
    };
  }
}

export async function deleteTaskAction(id: string): Promise<ActionResult> {
  try {
    await deleteTask(id);
    return { success: true, data: null };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete task',
    };
  }
}

export async function updateTaskStatusAction(id: string, status: string): Promise<ActionResult> {
  try {
    const validatedStatus = z.enum(taskStatusEnum.enumValues).parse(status);
    const task = await updateTask(id, { status: validatedStatus });
    return { success: true, data: task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update status',
    };
  }
}

export async function assignAgentAction(
  taskId: string,
  agentId: string | null,
): Promise<ActionResult> {
  try {
    const task = await updateTask(taskId, { assigneeAgentId: agentId });
    return { success: true, data: task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to assign agent',
    };
  }
}

export async function addDependencyAction(
  input: z.input<typeof dependencySchema>,
): Promise<ActionResult> {
  try {
    const validated = dependencySchema.parse(input);
    const dep = await addDependency(validated.taskId, validated.dependsOnTaskId);
    return { success: true, data: dep };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add dependency',
    };
  }
}

export async function removeDependencyAction(
  taskId: string,
  dependsOnTaskId: string,
): Promise<ActionResult> {
  try {
    await removeDependency(taskId, dependsOnTaskId);
    return { success: true, data: null };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to remove dependency',
    };
  }
}
