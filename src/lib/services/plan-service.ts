import { execFileSync } from 'child_process';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { plans } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import { createSession } from '@/lib/services/session-service';
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
}

export interface ExecutePlanOpts {
  agentId: string;
  capabilityId: string;
  permissionMode?: string;
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
 * Execute a plan by creating and enqueueing an agent session seeded with the
 * plan content as the initial prompt. Transitions plan status to 'executing'.
 */
export async function executePlan(
  planId: string,
  opts: ExecutePlanOpts,
): Promise<{ sessionId: string }> {
  const plan = await getPlan(planId);

  await db
    .update(plans)
    .set({ status: 'executing', updatedAt: new Date() })
    .where(eq(plans.id, planId));

  const session = await createSession({
    projectId: plan.projectId,
    kind: 'execution',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt: plan.content,
    permissionMode: opts.permissionMode as
      | 'default'
      | 'bypassPermissions'
      | 'acceptEdits'
      | 'plan'
      | 'dontAsk'
      | undefined,
    model: opts.model,
  });

  await db
    .update(plans)
    .set({ executingSessionId: session.id, updatedAt: new Date() })
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
