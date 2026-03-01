import { execFileSync } from 'child_process';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { plans } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import { createSession } from '@/lib/services/session-service';
import { createTask } from '@/lib/services/task-service';
import { enqueueSession } from '@/lib/worker/queue';
import type { Plan, PlanStatus, PlanMetadata } from '@/lib/types';

export interface CreatePlanInput {
  projectId: string;
  title: string;
  content: string;
  sourceSessionId?: string;
  metadata?: PlanMetadata;
}

export interface UpdatePlanPatch {
  title?: string;
  content?: string;
  status?: PlanStatus;
  metadata?: PlanMetadata;
  conversationSessionId?: string | null;
}

export interface StartPlanConversationOpts {
  agentId: string;
  capabilityId: string;
  model?: string;
}

export interface ExecutePlanOpts {
  agentId: string;
  capabilityId: string;
  model?: string;
}

export interface ValidatePlanOpts {
  agentId: string;
  capabilityId: string;
}

export async function createPlan(input: CreatePlanInput): Promise<Plan> {
  const [plan] = await db
    .insert(plans)
    .values({
      projectId: input.projectId,
      title: input.title,
      content: input.content,
      sourceSessionId: input.sourceSessionId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  return plan;
}

export async function getPlan(id: string): Promise<Plan> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  if (!plan) throw new NotFoundError('Plan', id);
  return plan;
}

export async function listPlans(filters?: {
  projectId?: string;
  status?: PlanStatus;
  limit?: number;
}): Promise<Plan[]> {
  const conditions = [];
  if (filters?.projectId) conditions.push(eq(plans.projectId, filters.projectId));
  if (filters?.status) conditions.push(eq(plans.status, filters.status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = filters?.limit ?? 50;

  return db.select().from(plans).where(where).orderBy(desc(plans.createdAt)).limit(limit);
}

export async function updatePlan(id: string, patch: UpdatePlanPatch): Promise<Plan> {
  const updateValues: Partial<typeof plans.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (patch.title !== undefined) updateValues.title = patch.title;
  if (patch.content !== undefined) updateValues.content = patch.content;
  if (patch.status !== undefined) updateValues.status = patch.status;
  if (patch.metadata !== undefined) updateValues.metadata = patch.metadata;
  if (patch.conversationSessionId !== undefined)
    updateValues.conversationSessionId = patch.conversationSessionId;

  const [updated] = await db.update(plans).set(updateValues).where(eq(plans.id, id)).returning();
  if (!updated) throw new NotFoundError('Plan', id);
  return updated;
}

export async function archivePlan(id: string): Promise<void> {
  const [updated] = await db
    .update(plans)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(plans.id, id))
    .returning({ id: plans.id });
  if (!updated) throw new NotFoundError('Plan', id);
}

/**
 * Execute a plan by:
 * 1. Creating a parent kanban task for visibility ("Execute: {title}")
 * 2. Creating and enqueueing an agent session seeded with task-creation instructions
 * 3. Linking both to the plan and transitioning its status to 'executing'.
 *
 * The session uses bypassPermissions so the agent can call MCP tools to create
 * subtasks and report progress.
 */
export async function executePlan(
  planId: string,
  opts: ExecutePlanOpts,
): Promise<{ sessionId: string; taskId: string }> {
  const plan = await getPlan(planId);

  // Create a parent task so execution is visible on the kanban board.
  const task = await createTask({
    title: `Execute: ${plan.title}`,
    description: `Executing implementation plan. Subtasks track individual steps.`,
    status: 'in_progress',
    projectId: plan.projectId,
  });

  const initialPrompt = `You are executing an implementation plan. Your job is to:

1. Read the plan carefully
2. Break it into subtasks using the mcp__agendo__create_task tool — one per major step
3. Execute each step in order, updating task status via mcp__agendo__update_task as you go
4. Report overall progress using mcp__agendo__add_progress_note on the parent task

Your parent task ID is: ${task.id}
Create all subtasks as children of this parent (set parentTaskId: "${task.id}").

PLAN TO EXECUTE:
${plan.content}

Start by creating subtasks for each major step, then execute them one by one.`;

  await db
    .update(plans)
    .set({ status: 'executing', updatedAt: new Date() })
    .where(eq(plans.id, planId));

  const session = await createSession({
    projectId: plan.projectId,
    taskId: task.id,
    kind: 'execution',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt,
    permissionMode: 'bypassPermissions',
    model: opts.model,
  });

  await db
    .update(plans)
    .set({
      executingSessionId: session.id,
      metadata: { ...plan.metadata, executingTaskId: task.id },
      updatedAt: new Date(),
    })
    .where(eq(plans.id, planId));

  await enqueueSession({ sessionId: session.id });

  return { sessionId: session.id, taskId: task.id };
}

/**
 * Start a collaborative conversation session for a plan. The agent reviews
 * and helps improve the plan, outputting suggested edits in a structured
 * format that the frontend can parse and apply.
 */
export async function startPlanConversation(
  planId: string,
  opts: StartPlanConversationOpts,
): Promise<{ sessionId: string }> {
  const plan = await getPlan(planId);

  const initialPrompt = `You are a collaborative plan editor. Review and help improve this implementation plan.

When you want to suggest changes to the plan, output your suggestion wrapped in:
<<<PLAN_EDIT
[the complete new plan content here]
PLAN_EDIT>>>

The user can apply or skip your suggestion directly in the editor.

You also have access to MCP task management tools. If the user asks you to create tasks from the plan,
use mcp__agendo__create_task to create them (one per major step).

Here is the current plan:

${plan.content}`;

  const session = await createSession({
    projectId: plan.projectId,
    kind: 'conversation',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt,
    permissionMode: 'bypassPermissions',
    model: opts.model,
  });

  await db
    .update(plans)
    .set({ conversationSessionId: session.id, updatedAt: new Date() })
    .where(eq(plans.id, planId));

  await enqueueSession({ sessionId: session.id });

  return { sessionId: session.id };
}

/**
 * Validate a plan by launching an agent session that reviews the plan against
 * the current codebase. Records the git HEAD hash and validation timestamp.
 * Uses execFileSync with a hardcoded argument array — no shell injection risk.
 */
export async function validatePlan(
  planId: string,
  opts: ValidatePlanOpts,
): Promise<{ sessionId: string }> {
  const plan = await getPlan(planId);

  const initialPrompt = `Review this plan against the current codebase. Report if anything is broken or outdated:\n\n${plan.content}`;

  const session = await createSession({
    projectId: plan.projectId,
    kind: 'conversation',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt,
  });

  let codebaseHash: string | undefined;
  try {
    // Hardcoded args array — no shell interpolation, no injection risk.
    codebaseHash = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    // git may not be available or the repo may have no commits — proceed without hash.
  }

  await db
    .update(plans)
    .set({
      lastValidatedAt: new Date(),
      ...(codebaseHash ? { codebaseHash } : {}),
      updatedAt: new Date(),
    })
    .where(eq(plans.id, planId));

  await enqueueSession({ sessionId: session.id });

  return { sessionId: session.id };
}
