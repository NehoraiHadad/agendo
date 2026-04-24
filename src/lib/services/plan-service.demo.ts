/**
 * Demo-mode shadow for plan-service.
 *
 * Exports fixture data and re-implements every public function from
 * plan-service.ts without touching the database. Mutations return believable
 * typed stubs with no side effects.
 *
 * Imported only via dynamic `await import('./plan-service.demo')` in demo mode
 * so it is tree-shaken from production bundles.
 *
 * Narrative: "Add MCP tool for task breakdown" — a completed plan that was
 * fully executed by Claude on the agendo project. The plan has 8 concrete
 * subtasks described in its content (not as DB rows — tasks are Agent A's scope).
 * Conversation history is captured across 3 plan versions.
 */

import { randomUUID } from 'crypto';
import { NotFoundError } from '@/lib/errors';
import type { Plan, PlanVersion, PlanStatus } from '@/lib/types';
import type {
  CreatePlanInput,
  UpdatePlanPatch,
  SearchPlanResult,
  ExecutePlanOpts,
  ValidatePlanOpts,
  StartPlanConversationOpts,
} from '@/lib/services/plan-service';

// ============================================================================
// Canonical demo UUIDs
// ============================================================================

export const DEMO_PLAN_ID = 'cccccccc-cccc-4001-c001-cccccccccccc';

export const DEMO_PLAN_VERSION_IDS = [
  'cccccccc-cccc-4011-c011-cccccccccccc', // version 1 — initial draft
  'cccccccc-cccc-4012-c012-cccccccccccc', // version 2 — refined scope
  'cccccccc-cccc-4013-c013-cccccccccccc', // version 3 — final ready
] as const;

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';
const AGENDO_PROJECT_ID = '44444444-4444-4444-a444-444444444444';

// ============================================================================
// Fixed deterministic timestamps
// ============================================================================

const T_V1 = new Date('2026-04-20T09:00:00.000Z'); // initial draft
const T_V2 = new Date('2026-04-20T10:30:00.000Z'); // refined after first conversation turn
const T_V3 = new Date('2026-04-20T14:00:00.000Z'); // final, approved
const T_EXECUTED = new Date('2026-04-21T08:00:00.000Z'); // execution completed

// ============================================================================
// Plan content — 8-step breakdown for "Add MCP tool for task breakdown"
// ============================================================================

const PLAN_CONTENT_V1 = `# Add MCP tool for task breakdown

## Overview

Add a new MCP tool \`breakdown_task\` that decomposes a high-level task into
concrete subtasks using the agent's own reasoning. This avoids manual task
entry and lets agents self-decompose complex requests.

## Rough steps

1. Define the tool schema
2. Implement the handler
3. Wire to task-service.createTask
4. Update MCP manifest
5. Add unit tests
6. Add CLI docs
`;

const PLAN_CONTENT_V2 = `# Add MCP tool for task breakdown

## Overview

Add a new MCP tool \`breakdown_task\` that decomposes a high-level task into
concrete subtasks using the agent's own reasoning. The tool is gated behind
a feature flag \`ENABLE_BREAKDOWN_TOOL\` until fully validated.

## Steps

1. **Define MCP tool schema** — Create \`src/mcp-server/tools/breakdown.ts\` with
   Zod-validated input schema: \`{ parentTaskId, context?, maxSubtasks? }\`.

2. **Implement handler** — The handler calls \`task-service.createTask()\` for each
   subtask, respecting the parent/child relationship.

3. **Wire to task-service** — Use the existing \`createTask\` API with \`parentTaskId\`
   set to the input \`parentTaskId\`.

4. **Update MCP manifest** — Register \`breakdown_task\` in \`src/mcp-server/index.ts\`.

5. **Write unit tests** — Test the schema validation, handler happy path, and
   task-service integration with vitest mocks.

6. **Add CLI docs** — Update \`docs/mcp-tools.md\` with tool description and example.

7. **Add telemetry hook** — Emit a \`tool_used:breakdown_task\` event to
   \`audit-service\` for usage tracking.

8. **Ship behind feature flag** — Gate with \`ENABLE_BREAKDOWN_TOOL=true\` env var.
   Default off for backward compat.
`;

/**
 * Final plan content — same structure as V2 with minor wording refinements.
 * This is what was actually executed by Claude.
 */
const PLAN_CONTENT_FINAL = `# Add MCP tool for task breakdown

## Overview

Add a new MCP tool \`breakdown_task\` that decomposes a high-level task into
concrete subtasks using the agent's own reasoning. Gated behind
\`ENABLE_BREAKDOWN_TOOL=true\` until validated in production.

## Implementation Steps

### Step 1 — Define MCP tool schema
Create \`src/mcp-server/tools/breakdown.ts\`.
Input: \`{ parentTaskId: string; context?: string; maxSubtasks?: number }\`.
Output: \`{ subtasks: Array<{ id: string; title: string }> }\`.
Validate with Zod; reject if \`parentTaskId\` does not exist.

### Step 2 — Implement handler
\`handlers/breakdown.ts\`: receives validated input, calls \`task-service.createTask()\`
for each generated subtask. Limit to \`maxSubtasks\` (default 10) to prevent runaway.

### Step 3 — Wire to task-service.createTask
Use the existing \`createTask({ title, parentTaskId, projectId })\` API.
No schema changes required.

### Step 4 — Update MCP manifest
Register in \`src/mcp-server/index.ts\` under the \`task_management\` group.
Add to the tool description list in \`src/mcp-server/registry.ts\`.

### Step 5 — Write unit tests
\`src/mcp-server/tools/__tests__/breakdown.test.ts\`:
- Schema validation (missing parentTaskId, maxSubtasks out of range)
- Handler happy path (mocked createTask)
- Integration: createTask called N times for N steps

### Step 6 — Add CLI docs
Update \`docs/mcp-tools.md\` with:
- Tool purpose, parameters, return type
- Example invocation and expected output

### Step 7 — Add telemetry hook
Emit \`audit-service.log({ action: 'tool_used', resourceType: 'mcp_tool', ... })\`
after successful decomposition.

### Step 8 — Ship behind feature flag
Guard with \`process.env.ENABLE_BREAKDOWN_TOOL === 'true'\`.
Default disabled. Enables on demo/staging first.
`;

// ============================================================================
// Plan fixture
// ============================================================================

/**
 * Canonical demo plan fixture — must satisfy Plan (InferSelectModel<typeof plans>).
 */
export const DEMO_PLAN: Plan = {
  id: DEMO_PLAN_ID,
  projectId: AGENDO_PROJECT_ID,
  title: 'Add MCP tool for task breakdown',
  content: PLAN_CONTENT_FINAL,
  status: 'done',
  sourceSessionId: CLAUDE_SESSION_ID,
  executingSessionId: CLAUDE_SESSION_ID,
  conversationSessionId: CLAUDE_SESSION_ID,
  lastValidatedAt: T_V3,
  codebaseHash: 'a1b2c3d4e5f6789012345678901234567890abcd',
  metadata: {
    tags: ['mcp', 'task-management', 'breakdown'],
    notes: 'All 8 steps completed and merged. Feature flag enabled on staging.',
    executingTaskId: 'aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa',
  },
  createdAt: T_V1,
  updatedAt: T_EXECUTED,
};

// ============================================================================
// Plan version fixtures
// ============================================================================

/**
 * Three plan versions — draft → refined → final.
 * Must satisfy PlanVersion (InferSelectModel<typeof planVersions>).
 */
export const DEMO_PLAN_VERSIONS: PlanVersion[] = [
  {
    id: DEMO_PLAN_VERSION_IDS[0],
    planId: DEMO_PLAN_ID,
    version: 1,
    content: PLAN_CONTENT_V1,
    title: 'Add MCP tool for task breakdown',
    metadata: { source: 'conversation', sessionId: CLAUDE_SESSION_ID, agentId: CLAUDE_AGENT_ID },
    createdAt: T_V1,
  },
  {
    id: DEMO_PLAN_VERSION_IDS[1],
    planId: DEMO_PLAN_ID,
    version: 2,
    content: PLAN_CONTENT_V2,
    title: 'Add MCP tool for task breakdown',
    metadata: { source: 'conversation', sessionId: CLAUDE_SESSION_ID, agentId: CLAUDE_AGENT_ID },
    createdAt: T_V2,
  },
  {
    id: DEMO_PLAN_VERSION_IDS[2],
    planId: DEMO_PLAN_ID,
    version: 3,
    content: PLAN_CONTENT_FINAL,
    title: 'Add MCP tool for task breakdown',
    metadata: { source: 'mcp', sessionId: CLAUDE_SESSION_ID },
    createdAt: T_V3,
  },
];

// All demo plans (single room for now)
const ALL_PLANS: Plan[] = [DEMO_PLAN];

// ============================================================================
// Query functions
// ============================================================================

/** Get a plan by ID. Throws NotFoundError for unknown IDs. */
export function getPlan(id: string): Plan {
  const plan = ALL_PLANS.find((p) => p.id === id);
  if (!plan) throw new NotFoundError('Plan', id);
  return plan;
}

/** List plans with optional filters. */
export function listPlans(filters?: {
  projectId?: string;
  status?: PlanStatus;
  limit?: number;
}): Plan[] {
  let plans = ALL_PLANS;

  if (filters?.projectId) {
    plans = plans.filter((p) => p.projectId === filters.projectId);
  }
  if (filters?.status) {
    plans = plans.filter((p) => p.status === filters.status);
  }

  const limit = filters?.limit ?? 50;
  return plans.slice(0, limit);
}

/** Search plans by title/content. */
export function searchPlans(q: string, limit = 5): SearchPlanResult[] {
  if (!q.trim()) return [];
  const lower = q.toLowerCase();
  const matched = ALL_PLANS.filter(
    (p) => p.title.toLowerCase().includes(lower) || p.content.toLowerCase().includes(lower),
  );
  return matched.slice(0, limit).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    projectId: p.projectId,
  }));
}

/** List all versions for a plan (metadata only, no content for non-existent plans). */
export function listPlanVersions(
  planId: string,
): Pick<PlanVersion, 'id' | 'version' | 'title' | 'createdAt' | 'metadata'>[] {
  return DEMO_PLAN_VERSIONS.filter((v) => v.planId === planId).map(
    ({ id, version, title, createdAt, metadata }) => ({ id, version, title, createdAt, metadata }),
  );
}

/** Get a specific version by plan ID and version number. */
export function getPlanVersion(planId: string, version: number): PlanVersion {
  const v = DEMO_PLAN_VERSIONS.find((pv) => pv.planId === planId && pv.version === version);
  if (!v) throw new NotFoundError('PlanVersion', `${planId}/v${version}`);
  return v;
}

/** Get two versions for client-side diff comparison. */
export function comparePlanVersions(
  planId: string,
  v1: number,
  v2: number,
): { v1: PlanVersion; v2: PlanVersion } {
  return { v1: getPlanVersion(planId, v1), v2: getPlanVersion(planId, v2) };
}

// ============================================================================
// Mutation stubs — no side effects, return typed stubs
// ============================================================================

/** Create a plan stub — does not persist anything. */
export function createPlan(input: CreatePlanInput): Plan {
  const now = new Date();
  return {
    id: randomUUID(),
    projectId: input.projectId,
    title: input.title,
    content: input.content,
    status: 'draft',
    sourceSessionId: input.sourceSessionId ?? null,
    executingSessionId: null,
    conversationSessionId: null,
    lastValidatedAt: null,
    codebaseHash: null,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Update a plan — returns merged stub without touching DB. */
export function updatePlan(id: string, patch: UpdatePlanPatch): Plan {
  const existing = ALL_PLANS.find((p) => p.id === id) ?? DEMO_PLAN;
  return {
    ...existing,
    id,
    ...(patch.title !== undefined && { title: patch.title }),
    ...(patch.content !== undefined && { content: patch.content }),
    ...(patch.status !== undefined && { status: patch.status }),
    ...(patch.metadata !== undefined && { metadata: patch.metadata }),
    ...(patch.conversationSessionId !== undefined && {
      conversationSessionId: patch.conversationSessionId,
    }),
    updatedAt: new Date(),
  };
}

/** Archive a plan — no-op stub. */
export function archivePlan(_id: string): void {
  // No side effects in demo mode
}

/**
 * Execute a plan — returns a would-be-mutated stub.
 * The DemoGuard in Phase 4 prevents users from clicking Execute,
 * but programmatic callers still get a typed result.
 */
export function executePlan(
  _planId: string,
  _opts: ExecutePlanOpts,
): { sessionId: string; taskId: string } {
  return {
    sessionId: randomUUID(),
    taskId: 'aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa',
  };
}

/**
 * Break plan into tasks — returns a stub session ID.
 */
export function breakPlanIntoTasks(_planId: string, _opts: ExecutePlanOpts): { sessionId: string } {
  return { sessionId: randomUUID() };
}

/**
 * Start plan conversation — returns a stub session ID.
 */
export function startPlanConversation(
  _planId: string,
  _opts: StartPlanConversationOpts,
): { sessionId: string } {
  return { sessionId: randomUUID() };
}

/**
 * Validate a plan — returns a stub session ID.
 */
export function validatePlan(_planId: string, _opts: ValidatePlanOpts): { sessionId: string } {
  return { sessionId: randomUUID() };
}

/**
 * Save plan content as a version.
 * Returns null if content matches DEMO_PLAN.content (deduplication).
 * Returns a stub new version otherwise.
 */
export function savePlanContent(
  planId: string,
  content: string,
  _metadata: object = {},
): PlanVersion | null {
  const existing = ALL_PLANS.find((p) => p.id === planId);

  // Deduplication: if content matches the plan's current content, return null
  if (existing && existing.content === content) return null;

  // Otherwise return a stub new version
  const latestVersion = DEMO_PLAN_VERSIONS.filter((v) => v.planId === planId).reduce(
    (max, v) => Math.max(max, v.version),
    0,
  );

  return {
    id: randomUUID(),
    planId,
    version: latestVersion + 1,
    content,
    title:
      content
        .split('\n')
        .find((l) => l.trim())
        ?.replace(/^#+\s*/, '')
        .trim() ?? 'Untitled',
    metadata: {},
    createdAt: new Date(),
  };
}

/**
 * Save or update a plan from an MCP tool call.
 * In demo mode: returns a stub result without DB writes.
 */
export function savePlanFromMcp(
  _sessionId: string | undefined,
  content: string,
  title?: string,
  planId?: string,
): { planId: string; title: string; action: 'created' | 'updated'; artifactId?: string } {
  const resolvedTitle =
    title?.trim() ||
    (content
      .split('\n')
      .find((l) => l.trim())
      ?.replace(/^#+\s*/, '')
      .trim() ??
      'Untitled Plan');

  if (planId) {
    return { planId, title: resolvedTitle, action: 'updated' };
  }

  return { planId: randomUUID(), title: resolvedTitle, action: 'created' };
}
