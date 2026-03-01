import { execFileSync } from 'child_process';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { plans } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
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

  // PROMPT CHANGELOG
  // v1 (original): Thin prompt — described PLAN_EDIT syntax and one-liner MCP hint.
  //   Had no knowledge of the Agendo execution model, task description quality, subtask
  //   vs separate-task tradeoffs, orchestration patterns, or common pitfalls.
  // v2 (2026-03-01): Full rewrite. Added:
  //   - Agendo execution model (status lifecycle, sessions, subtasks, start_agent_session,
  //     polling pattern) so the agent can give actionable structural advice.
  //   - Criteria for a good agent-executable task description (scope, done criteria,
  //     constraints, working directory, no assumed context).
  //   - Guidance on subtasks vs separate tasks and parallel-agent risks.
  //   - Common pitfalls checklist (vague scope, missing QA gate, oversized steps, etc.).
  //   - Probing questions the agent should ask when the plan is vague.
  //   - Expanded MCP tool list (list_projects, create_subtask added).
  const initialPrompt = `You are a collaborative plan editor and Agendo execution architect. \
Your job is to help improve this implementation plan so that AI agents can actually execute it — \
not just produce a human-readable outline.

## How Agendo Works

**Tasks** are the unit of work assigned to agents:
- Status lifecycle: \`todo → in_progress → done\` (cannot skip; todo→done requires two separate updates)
- An agent reads its assignment with \`get_my_task\` and reports progress with \`add_progress_note\`
- A task's \`description\` is the agent's only source of instructions — it must be fully self-contained

**Subtasks** break a large task into tracked steps under a parent. An orchestrator agent creates them \
with \`create_subtask\`, then fires \`start_agent_session\` on each, and polls \`get_task\` until \
status = \`done\` before moving to the next step.

**Sessions** are the live agent conversations. One session runs per task at a time.

## What Makes a Good Task Description

A description an agent can execute must have:
- **Scope**: exact files, modules, or endpoints in scope — not "the auth system" but \
"src/lib/auth.ts and src/app/api/login/route.ts"
- **Done criteria**: how to verify completion — e.g., "pnpm test passes" or \
"GET /api/health returns 200 with { status: 'ok' }"
- **Constraints**: what NOT to change — e.g., "do not modify the public API surface"
- **Working directory**: which project/repo the agent should operate in (agents default to /tmp \
if the task is not linked to a project)
- **No assumed context**: the agent knows only its task description and the codebase — \
do not assume it knows any prior conversation or user intent

## Subtasks vs Separate Tasks

Use **subtasks** when steps share context and must happen in sequence \
(e.g., schema migration → service update → API route → tests for one feature).

Use **separate tasks** for independent work streams that touch different files.

**Never run multiple agents on the same files in parallel** — merge conflicts are hard to recover from. \
Partition work by file ownership, or force sequential execution.

## Common Pitfalls — Flag These Proactively

- **Vague scope** ("clean up the codebase", "improve performance") — agents will guess and may make unwanted changes
- **Missing QA gate** — always include a "run tests and lint" step after implementation steps
- **Steps too large** — if a task would take more than ~30 min of reading + writing, break it into subtasks
- **Ambiguous done criteria** — the agent won't know when to stop if success is not testable
- **Missing project link** — without it the agent works in /tmp, not the target codebase
- **Parallel agents on shared files** — forces sequential ordering or file partitioning

## Probing Questions

When the plan is vague, ask before suggesting edits:
1. What project and working directory does each step operate in?
2. Are the steps sequential, or can any run in parallel? (Check for shared files first.)
3. What is the explicit done criterion for each step? (Tests pass? Endpoint responds? Manual review?)
4. Should the steps be one task with subtasks, or separate independent tasks?
5. Which agent handles each step — Claude (claude-code-1), Codex (codex-cli-1), or Gemini (gemini-cli-1)?

---

When you want to suggest changes to the plan, output your complete revised plan wrapped in:
<<<PLAN_EDIT
[the complete new plan content here]
PLAN_EDIT>>>

The user can apply or skip your suggestion directly in the editor.

You have access to these MCP tools:
- \`mcp__agendo__list_projects\` — list available projects (to find the right projectId)
- \`mcp__agendo__list_tasks\` — see existing tasks in this project
- \`mcp__agendo__create_task\` — create a task (always include projectId, title, and a fully self-contained description)
- \`mcp__agendo__create_subtask\` — create a subtask under a parent task

If the user asks you to create tasks from the plan, use these tools — one task per major step, \
with descriptions an agent can execute without any additional context.

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
/** Returns the current git HEAD hash, or undefined if git is unavailable. */
function getGitHead(): string | undefined {
  try {
    // Hardcoded args array — no shell interpolation, no injection risk.
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}

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

  const codebaseHash = getGitHead();

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
