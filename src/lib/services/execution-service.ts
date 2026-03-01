import { eq, and, desc, sql, count, getTableColumns } from 'drizzle-orm';
import { db } from '@/lib/db';
import { executions, tasks, agents, agentCapabilities, taskEvents } from '@/lib/db/schema';
import { isValidExecutionTransition } from '@/lib/state-machines';
import { ConflictError } from '@/lib/errors';
import { requireFound } from '@/lib/api-handler';
import { checkLoopGuards } from '@/lib/services/loop-prevention';
import type { Execution, ExecutionStatus, Agent, AgentCapability } from '@/lib/types';

// --- Types ---

export interface CreateExecutionInput {
  taskId: string;
  agentId: string;
  capabilityId: string;
  args?: Record<string, unknown>;
  cliFlags?: Record<string, string | boolean>;
  parentExecutionId?: string;
  sessionRef?: string;
  promptOverride?: string;
  sessionId?: string;
}

export interface ListExecutionsInput {
  taskId?: string;
  agentId?: string;
  status?: ExecutionStatus;
  page?: number;
  pageSize?: number;
}

export interface ExecutionWithDetails extends Execution {
  agent: Pick<Agent, 'id' | 'name' | 'slug'>;
  capability: Pick<AgentCapability, 'id' | 'label' | 'key' | 'interactionMode'>;
}

// --- Implementation ---

export async function createExecution(input: CreateExecutionInput): Promise<Execution> {
  // Loop prevention: check spawn depth and concurrent limits
  const { spawnDepth } = await checkLoopGuards({
    parentExecutionId: input.parentExecutionId,
    agentId: input.agentId,
  });

  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
  requireFound(agent, 'Agent', input.agentId);

  const [capability] = await db
    .select()
    .from(agentCapabilities)
    .where(
      and(
        eq(agentCapabilities.id, input.capabilityId),
        eq(agentCapabilities.agentId, input.agentId),
      ),
    )
    .limit(1);
  requireFound(capability, 'Capability', input.capabilityId);

  const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  requireFound(task, 'Task', input.taskId);

  const [{ runningCount }] = await db
    .select({ runningCount: count() })
    .from(executions)
    .where(
      and(
        eq(executions.agentId, input.agentId),
        sql`${executions.status} IN ('queued', 'running')`,
      ),
    );
  if (runningCount >= agent.maxConcurrent) {
    throw new ConflictError(
      `Agent "${agent.name}" is at max concurrency (${agent.maxConcurrent}).`,
    );
  }

  const [execution] = await db
    .insert(executions)
    .values({
      taskId: input.taskId,
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      args: input.args ?? {},
      cliFlags: input.cliFlags ?? {},
      mode: capability.interactionMode,
      status: 'queued',
      parentExecutionId: input.parentExecutionId,
      sessionRef: input.sessionRef,
      promptOverride: input.promptOverride,
      spawnDepth,
      sessionId: input.sessionId,
    })
    .returning();

  if (task.status === 'todo') {
    await db
      .update(tasks)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
  }

  await db.insert(taskEvents).values({
    taskId: input.taskId,
    actorType: 'user',
    actorId: execution.requestedBy,
    eventType: 'execution_created',
    payload: { executionId: execution.id, capabilityId: input.capabilityId },
  });

  return execution;
}

export async function cancelExecution(executionId: string): Promise<Execution> {
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);
  requireFound(execution, 'Execution', executionId);

  if (!isValidExecutionTransition(execution.status, 'cancelling')) {
    throw new ConflictError(`Cannot cancel execution in "${execution.status}" status`);
  }

  const [updated] = await db
    .update(executions)
    .set({ status: 'cancelling' })
    .where(and(eq(executions.id, executionId), sql`${executions.status} IN ('queued', 'running')`))
    .returning();
  if (!updated) throw new ConflictError('Execution status changed concurrently');
  return updated;
}

export async function getExecutionById(executionId: string): Promise<ExecutionWithDetails> {
  const rows = await db
    .select({
      execution: executions,
      agentId: agents.id,
      agentName: agents.name,
      agentSlug: agents.slug,
      capId: agentCapabilities.id,
      capLabel: agentCapabilities.label,
      capKey: agentCapabilities.key,
      capMode: agentCapabilities.interactionMode,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .innerJoin(agentCapabilities, eq(executions.capabilityId, agentCapabilities.id))
    .where(eq(executions.id, executionId))
    .limit(1);

  const row = requireFound(rows[0], 'Execution', executionId);
  return {
    ...row.execution,
    agent: { id: row.agentId, name: row.agentName, slug: row.agentSlug },
    capability: {
      id: row.capId,
      label: row.capLabel,
      key: row.capKey,
      interactionMode: row.capMode,
    },
  };
}

export async function listExecutions(input: ListExecutionsInput = {}): Promise<{
  data: (Execution & { agentName: string | null; capLabel: string | null })[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  const conditions = [];
  if (input.taskId) conditions.push(eq(executions.taskId, input.taskId));
  if (input.agentId) conditions.push(eq(executions.agentId, input.agentId));
  if (input.status) conditions.push(eq(executions.status, input.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, [{ total }]] = await Promise.all([
    db
      .select({
        ...getTableColumns(executions),
        agentName: agents.name,
        capLabel: agentCapabilities.label,
      })
      .from(executions)
      .leftJoin(agents, eq(executions.agentId, agents.id))
      .leftJoin(agentCapabilities, eq(executions.capabilityId, agentCapabilities.id))
      .where(where)
      .orderBy(desc(executions.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(executions).where(where),
  ]);

  return { data, total, page, pageSize };
}
