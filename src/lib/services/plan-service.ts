import { eq, and, desc, or, ilike } from 'drizzle-orm';
import { db } from '@/lib/db';
import { plans, planVersions, sessions } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import { createAndEnqueueSession } from '@/lib/services/session-helpers';
import { getAgentById } from '@/lib/services/agent-service';
import { createTask } from '@/lib/services/task-service';
import { getBinaryName } from '@/lib/worker/agent-utils';
import { buildPlanContext, generatePlanConversationPreamble } from '@/lib/worker/session-preambles';
import { getGitHead } from '@/lib/utils/git';
import type { Plan, PlanVersion, PlanStatus, PlanMetadata, PlanVersionMetadata } from '@/lib/types';

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
  /** Optional user feedback to prepend to the agent-specific preamble. */
  initialPrompt?: string;
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

export interface SearchPlanResult {
  id: string;
  title: string;
  status: string;
  projectId: string;
}

export async function searchPlans(q: string, limit = 5): Promise<SearchPlanResult[]> {
  const rows = await db
    .select({ id: plans.id, title: plans.title, status: plans.status, projectId: plans.projectId })
    .from(plans)
    .where(or(ilike(plans.title, `%${q}%`), ilike(plans.content, `%${q}%`)))
    .orderBy(desc(plans.updatedAt))
    .limit(limit);

  return rows;
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
  return requireFound(plan, 'Plan', id);
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
  return requireFound(updated, 'Plan', id);
}

export async function archivePlan(id: string): Promise<void> {
  const [updated] = await db
    .update(plans)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(plans.id, id))
    .returning({ id: plans.id });
  requireFound(updated, 'Plan', id);
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

  const session = await createAndEnqueueSession({
    projectId: plan.projectId,
    taskId: task.id,
    kind: 'conversation',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt,
    permissionMode: 'bypassPermissions',
    model: opts.model,
    beforeEnqueue: async (s) => {
      await db
        .update(plans)
        .set({
          executingSessionId: s.id,
          metadata: { ...plan.metadata, executingTaskId: task.id },
          updatedAt: new Date(),
        })
        .where(eq(plans.id, planId));
    },
  });

  return { sessionId: session.id, taskId: task.id };
}

/**
 * Break a plan into tasks by creating an agent session that decomposes the
 * plan into individual tasks using MCP tools. Unlike executePlan(), the agent
 * only creates the tasks — it does NOT execute them. The user can review,
 * reorder, and edit the created tasks before kicking off execution separately.
 */
export async function breakPlanIntoTasks(
  planId: string,
  opts: ExecutePlanOpts,
): Promise<{ sessionId: string }> {
  const plan = await getPlan(planId);

  const initialPrompt = `You are a task breakdown specialist. Your ONLY job is to decompose the following plan into \
actionable tasks using the Agendo MCP tools. Do NOT implement anything — just create the tasks.

For each major step in the plan:
1. Use mcp__agendo__create_task with:
   - projectId: "${plan.projectId}"
   - A clear, specific title
   - A fully self-contained description that an AI agent can execute without any additional context
   - Each description must include: scope (exact files/modules to touch), done criteria (how to verify \
completion), and constraints (what NOT to change)
2. For steps that must run in sequence, use mcp__agendo__create_subtask to group them under a parent task
3. Set appropriate priorities (highest for critical path, lower for independent work)

After creating all tasks, report a summary of what you created using mcp__agendo__add_progress_note.

PLAN TO DECOMPOSE:

${plan.content}

Remember: create tasks only. Do NOT implement any code changes.`;

  const session = await createAndEnqueueSession({
    projectId: plan.projectId,
    kind: 'conversation',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt,
    permissionMode: 'bypassPermissions',
    model: opts.model,
  });

  return { sessionId: session.id };
}

/**
 * Start a plan conversation using the agent's native plan mode.
 *
 * For Claude: `--permission-mode plan` puts the agent in read-only mode.
 *   The agent reviews the codebase, discusses improvements, and when ready
 *   calls ExitPlanMode which writes the plan to ~/.claude/plans/.
 *   savePlanFromSession() then auto-saves the content to the plans table.
 *
 * For Codex: plan mode maps to `--sandbox read-only`.
 *
 * For Gemini: plan mode is not natively supported — the agent runs in
 *   default mode, so each tool call is approved individually.
 */
export async function startPlanConversation(
  planId: string,
  opts: StartPlanConversationOpts,
): Promise<{ sessionId: string }> {
  const [plan, agent] = await Promise.all([getPlan(planId), getAgentById(opts.agentId)]);

  const binaryName = getBinaryName(agent);

  // PROMPT CHANGELOG
  // v1 (original): Thin prompt — described PLAN_EDIT syntax and one-liner MCP hint.
  // v2 (2026-03-01): Full rewrite — Agendo execution model, task quality criteria,
  //   subtask/separate-task guidance, common pitfalls, probing questions.
  // v3 (2026-03-04): Native plan mode. Removed PLAN_EDIT hack — the agent uses
  //   its CLI's native plan mode (ExitPlanMode for Claude, read-only sandbox for
  //   Codex). Plan content is captured from the CLI's plan file (~/.claude/plans/)
  //   and auto-saved to the plans table on approval. Kept Agendo execution context
  //   so the agent can produce agent-executable plans.
  // v4 (2026-03-04): Agent-specific prompts. Claude keeps ExitPlanMode. Codex and
  //   Gemini get tailored prompts using mcp__agendo__save_plan as the finalization
  //   mechanism. permissionMode is set per agent (Gemini uses bypassPermissions since
  //   ACP doesn't support plan mode yet).
  const planContext = buildPlanContext(plan.content);
  const { prompt: initialPrompt, permissionMode } = generatePlanConversationPreamble(
    binaryName,
    planContext,
  );

  // If the caller supplies an initialPrompt (e.g. serialized plan annotations),
  // prepend it before the agent-specific preamble so the agent sees the user's
  // feedback first and can incorporate it while reviewing/refining the plan.
  const finalPrompt = opts.initialPrompt
    ? `## User Feedback on the Plan\n\n${opts.initialPrompt}\n\n---\n\n${initialPrompt}`
    : initialPrompt;

  const session = await createAndEnqueueSession({
    projectId: plan.projectId,
    kind: 'conversation',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt: finalPrompt,
    permissionMode,
    model: opts.model,
    beforeEnqueue: async (s) => {
      await db
        .update(plans)
        .set({ conversationSessionId: s.id, updatedAt: new Date() })
        .where(eq(plans.id, planId));
    },
  });

  return { sessionId: session.id };
}

/**
 * Validate a plan by launching an agent session that reviews the plan against
 * the current codebase. Records the git HEAD hash and validation timestamp.
 */

/**
 * Save or update a plan from an MCP tool call.
 *
 * Resolution order:
 * 1. If planId provided: update that plan directly.
 * 2. If sessionId provided and session is linked to an existing plan
 *    (via conversationSessionId): update that plan.
 * 3. Otherwise: create a new plan record linked to the session's project.
 */
export async function savePlanFromMcp(
  sessionId: string | undefined,
  content: string,
  title?: string,
  planId?: string,
): Promise<{ planId: string; title: string; action: 'created' | 'updated' }> {
  // Extract title from first heading if not provided
  const resolvedTitle =
    title?.trim() ||
    (() => {
      const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? 'Untitled Plan';
      return (
        firstLine
          .replace(/^#+\s*/, '')
          .trim()
          .slice(0, 200) || 'Untitled Plan'
      );
    })();

  const versionMeta: PlanVersionMetadata = { source: 'mcp', sessionId: sessionId ?? undefined };

  // 1. Explicit planId — update directly + create version.
  if (planId) {
    await savePlanContent(planId, content, versionMeta);
    const updated = await updatePlan(planId, { content, title: resolvedTitle, status: 'ready' });
    return { planId: updated.id, title: updated.title, action: 'updated' };
  }

  // 2. Look up session to find linked plan or project.
  if (sessionId) {
    const [session] = await db
      .select({ id: sessions.id, projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (session) {
      // Check for a plan linked to this session.
      const [linked] = await db
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.conversationSessionId, sessionId))
        .limit(1);

      if (linked) {
        await savePlanContent(linked.id, content, versionMeta);
        const updated = await updatePlan(linked.id, {
          content,
          title: resolvedTitle,
          status: 'ready',
        });
        return { planId: updated.id, title: updated.title, action: 'updated' };
      }

      // Create new plan linked to the session's project.
      if (session.projectId) {
        const created = await createPlan({
          projectId: session.projectId,
          title: resolvedTitle,
          content,
          sourceSessionId: sessionId,
        });
        await updatePlan(created.id, { status: 'ready' });
        await savePlanContent(created.id, content, versionMeta);
        return { planId: created.id, title: created.title, action: 'created' };
      }
    }
  }

  throw new Error(
    'Cannot save plan: no planId provided, no session found, or session has no projectId.',
  );
}

// ---------------------------------------------------------------------------
// Plan Version History
// ---------------------------------------------------------------------------

function extractTitle(content: string): string {
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? 'Untitled Plan';
  return (
    firstLine
      .replace(/^#+\s*/, '')
      .trim()
      .slice(0, 200) || 'Untitled Plan'
  );
}

/**
 * Save plan content as a new version. Deduplicates if latest version has
 * identical content. Also updates plans.content for backward compat.
 */
export async function savePlanContent(
  planId: string,
  content: string,
  metadata: PlanVersionMetadata = {},
): Promise<PlanVersion | null> {
  const [latest] = await db
    .select({ version: planVersions.version, content: planVersions.content })
    .from(planVersions)
    .where(eq(planVersions.planId, planId))
    .orderBy(desc(planVersions.version))
    .limit(1);

  if (latest && latest.content === content) {
    return null;
  }

  const nextVersion = (latest?.version ?? 0) + 1;
  const title = extractTitle(content);

  const [version] = await db
    .insert(planVersions)
    .values({ planId, version: nextVersion, content, title, metadata })
    .returning();

  await db.update(plans).set({ content, title, updatedAt: new Date() }).where(eq(plans.id, planId));

  return version;
}

/**
 * List all versions for a plan (metadata only, no content).
 */
export async function listPlanVersions(
  planId: string,
): Promise<Pick<PlanVersion, 'id' | 'version' | 'title' | 'createdAt' | 'metadata'>[]> {
  return db
    .select({
      id: planVersions.id,
      version: planVersions.version,
      title: planVersions.title,
      createdAt: planVersions.createdAt,
      metadata: planVersions.metadata,
    })
    .from(planVersions)
    .where(eq(planVersions.planId, planId))
    .orderBy(desc(planVersions.version));
}

/**
 * Get a specific version by plan ID and version number.
 */
export async function getPlanVersion(planId: string, version: number): Promise<PlanVersion> {
  const [row] = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.planId, planId), eq(planVersions.version, version)))
    .limit(1);
  return requireFound(row, 'PlanVersion', `${planId}/v${version}`);
}

/**
 * Get two versions for client-side diff comparison.
 */
export async function comparePlanVersions(
  planId: string,
  v1: number,
  v2: number,
): Promise<{ v1: PlanVersion; v2: PlanVersion }> {
  const [ver1, ver2] = await Promise.all([getPlanVersion(planId, v1), getPlanVersion(planId, v2)]);
  return { v1: ver1, v2: ver2 };
}

export async function validatePlan(
  planId: string,
  opts: ValidatePlanOpts,
): Promise<{ sessionId: string }> {
  const plan = await getPlan(planId);

  const initialPrompt = `Review this plan against the current codebase. Report if anything is broken or outdated:\n\n${plan.content}`;

  const codebaseHash = getGitHead();

  const session = await createAndEnqueueSession({
    projectId: plan.projectId,
    kind: 'conversation',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt,
    beforeEnqueue: async () => {
      await db
        .update(plans)
        .set({
          lastValidatedAt: new Date(),
          ...(codebaseHash ? { codebaseHash } : {}),
          updatedAt: new Date(),
        })
        .where(eq(plans.id, planId));
    },
  });

  return { sessionId: session.id };
}
