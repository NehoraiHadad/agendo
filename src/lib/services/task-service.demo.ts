/**
 * Demo-mode shadow for task-service.ts.
 *
 * All exported functions mirror the real service's signatures exactly, but
 * operate entirely on in-memory fixtures — no database access.
 *
 * Mutations return plausible stubs (create synthesises a new row with a fresh
 * UUID; update returns a merged fixture; delete/reorder return shape-correct
 * values). Nothing is persisted.
 *
 * Imported only via dynamic `await import('./task-service.demo')` in demo
 * mode so it is tree-shaken from production bundles.
 */

import { randomUUID } from 'crypto';
import { NotFoundError } from '@/lib/errors';
import type { Task, TaskStatus } from '@/lib/types';
import type {
  TaskBoardItem,
  CreateTaskInput,
  UpdateTaskInput,
  TaskWithDetails,
  ListTasksOptions,
  ReorderTaskInput,
  SearchTaskResult,
  SearchProgressNoteResult,
  SetExecutionOrderInput,
} from '@/lib/services/task-service';

// ============================================================================
// Canonical shared IDs (must match across all Phase-1 agents)
// ============================================================================

const AGENT_CLAUDE = '11111111-1111-4111-a111-111111111111';
const AGENT_CODEX = '22222222-2222-4222-a222-222222222222';
const AGENT_GEMINI = '33333333-3333-4333-a333-333333333333';

const PROJECT_AGENDO = '44444444-4444-4444-a444-444444444444';
const PROJECT_OTHER_APP = '55555555-5555-4555-a555-555555555555';
const PROJECT_PLAYGROUND = '66666666-6666-4666-a666-666666666666';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';

// Fixed reference point for deterministic timestamps (today in the fixture arc)
const NOW = new Date('2026-04-23T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

// ============================================================================
// Fixture data — 15 tasks covering a believable "build agendo" arc
// ============================================================================

// Task IDs: aaaaaaaa-aaaa-4NNN-aNNN-aaaaaaaaaaaa (N = 01-15)
const T = {
  T01: 'aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa',
  T02: 'aaaaaaaa-aaaa-4002-a002-aaaaaaaaaaaa',
  T03: 'aaaaaaaa-aaaa-4003-a003-aaaaaaaaaaaa',
  T04: 'aaaaaaaa-aaaa-4004-a004-aaaaaaaaaaaa',
  T05: 'aaaaaaaa-aaaa-4005-a005-aaaaaaaaaaaa',
  T06: 'aaaaaaaa-aaaa-4006-a006-aaaaaaaaaaaa',
  T07: 'aaaaaaaa-aaaa-4007-a007-aaaaaaaaaaaa',
  T08: 'aaaaaaaa-aaaa-4008-a008-aaaaaaaaaaaa',
  T09: 'aaaaaaaa-aaaa-4009-a009-aaaaaaaaaaaa',
  T10: 'aaaaaaaa-aaaa-4010-a010-aaaaaaaaaaaa',
  T11: 'aaaaaaaa-aaaa-4011-a011-aaaaaaaaaaaa',
  T12: 'aaaaaaaa-aaaa-4012-a012-aaaaaaaaaaaa',
  T13: 'aaaaaaaa-aaaa-4013-a013-aaaaaaaaaaaa',
  T14: 'aaaaaaaa-aaaa-4014-a014-aaaaaaaaaaaa',
  T15: 'aaaaaaaa-aaaa-4015-a015-aaaaaaaaaaaa',
} as const;

/**
 * Base fixture rows. All fields must satisfy `typeof tasks.$inferSelect`.
 * Use `satisfies readonly Task[]` for compile-time type checking.
 */
export const DEMO_TASKS = [
  // ── DONE (4) ──────────────────────────────────────────────────────────────
  {
    id: T.T01,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_AGENDO,
    title: 'Bootstrap Next.js 16 project with Drizzle ORM',
    description: 'Set up project scaffold: app router, Drizzle, pg-boss, Tailwind, shadcn/ui.',
    status: 'done' as TaskStatus,
    priority: 1,
    sortOrder: 1000,
    executionOrder: 1,
    assigneeAgentId: AGENT_CLAUDE,
    inputContext: { workingDir: '/home/ubuntu/projects/agendo' },
    dueAt: null,
    createdAt: daysAgo(7),
    updatedAt: daysAgo(6),
  },
  {
    id: T.T02,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: T.T01, // subtask of T01
    projectId: PROJECT_AGENDO,
    title: 'Design Drizzle schema for tasks, agents and sessions',
    description: 'Define pgEnum, pgTable for tasks, agents, sessions, executions.',
    status: 'done' as TaskStatus,
    priority: 1,
    sortOrder: 2000,
    executionOrder: 2,
    assigneeAgentId: AGENT_CLAUDE,
    inputContext: { workingDir: '/home/ubuntu/projects/agendo' },
    dueAt: null,
    createdAt: daysAgo(7),
    updatedAt: daysAgo(6),
  },
  {
    id: T.T03,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: T.T01, // subtask of T01
    projectId: PROJECT_AGENDO,
    title: 'Wire up pg-boss worker with execute-capability job handler',
    description: 'Integrate pg-boss v10; set up job queue for capability execution.',
    status: 'done' as TaskStatus,
    priority: 2,
    sortOrder: 3000,
    executionOrder: 3,
    assigneeAgentId: AGENT_CODEX,
    inputContext: { workingDir: '/home/ubuntu/projects/agendo' },
    dueAt: null,
    createdAt: daysAgo(6),
    updatedAt: daysAgo(5),
  },
  {
    id: T.T04,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_AGENDO,
    title: 'Implement Kanban board with drag-and-drop reordering',
    description: 'SSE-powered live board, sparse sort_order gaps, optimistic UI updates.',
    status: 'done' as TaskStatus,
    priority: 2,
    sortOrder: 4000,
    executionOrder: 4,
    assigneeAgentId: AGENT_GEMINI,
    inputContext: {},
    dueAt: null,
    createdAt: daysAgo(5),
    updatedAt: daysAgo(4),
  },
  // ── IN_PROGRESS (3) ───────────────────────────────────────────────────────
  {
    id: T.T05,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_AGENDO,
    title: 'Wire up MCP tool handler for task_create',
    description:
      'Expose create_task, update_task, get_my_task MCP tools via stdio transport. Add Cedar policy for agent role scopes.',
    status: 'in_progress' as TaskStatus,
    priority: 2,
    sortOrder: 1000,
    executionOrder: 5,
    assigneeAgentId: AGENT_CLAUDE,
    inputContext: {
      workingDir: '/home/ubuntu/projects/agendo',
      promptAdditions: 'Use @modelcontextprotocol/sdk stdio transport.',
    },
    dueAt: new Date('2026-04-25T00:00:00Z'),
    createdAt: daysAgo(4),
    updatedAt: daysAgo(1),
  },
  {
    id: T.T06,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_AGENDO,
    title: 'Refactor session reconnect to use lastEventId',
    description:
      'Replace polling reconnect with SSE lastEventId catchup from log file. Prevents missed events on network blip.',
    status: 'in_progress' as TaskStatus,
    priority: 2,
    sortOrder: 2000,
    executionOrder: 6,
    assigneeAgentId: AGENT_CODEX,
    inputContext: { workingDir: '/home/ubuntu/projects/agendo' },
    dueAt: null,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(1),
  },
  {
    id: T.T07,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_OTHER_APP,
    title: 'Add Cedar policy for agent role scopes',
    description: 'Define Cedar schema + policies for admin vs member vs agent roles.',
    status: 'in_progress' as TaskStatus,
    priority: 3,
    sortOrder: 1000,
    executionOrder: null,
    assigneeAgentId: AGENT_GEMINI,
    inputContext: { workingDir: '/home/ubuntu/projects/my-other-app' },
    dueAt: new Date('2026-04-26T00:00:00Z'),
    createdAt: daysAgo(3),
    updatedAt: daysAgo(1),
  },
  // ── BLOCKED (2) ───────────────────────────────────────────────────────────
  {
    id: T.T08,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_AGENDO,
    title: 'Integrate OpenTelemetry traces for worker job spans',
    description:
      'Add @opentelemetry/sdk-node to worker; emit spans for job dequeue, execution start/end.',
    status: 'blocked' as TaskStatus,
    priority: 3,
    sortOrder: 1000,
    executionOrder: null,
    assigneeAgentId: AGENT_CODEX,
    inputContext: {
      workingDir: '/home/ubuntu/projects/agendo',
      promptAdditions:
        'Blocked: waiting on upstream OTel collector infra. Resume once collector endpoint is provisioned.',
    },
    dueAt: null,
    createdAt: daysAgo(4),
    updatedAt: daysAgo(2),
  },
  {
    id: T.T09,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_OTHER_APP,
    title: 'Deploy Postgres RLS policies for multi-tenant data isolation',
    description: 'Enable row-level security on tasks and sessions; set workspace_id predicate.',
    status: 'blocked' as TaskStatus,
    priority: 2,
    sortOrder: 2000,
    executionOrder: null,
    assigneeAgentId: AGENT_CLAUDE,
    inputContext: {
      promptAdditions:
        'Blocked: pending DB admin access to production instance. Unblocks after IAM ticket #447 resolves.',
    },
    dueAt: null,
    createdAt: daysAgo(5),
    updatedAt: daysAgo(2),
  },
  // ── TODO (5) ──────────────────────────────────────────────────────────────
  {
    id: T.T10,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_AGENDO,
    title: 'Build session terminal view with xterm.js and WebSocket relay',
    description:
      'Render agent stdout in xterm.js; relay via ws:// through agendo-terminal service.',
    status: 'todo' as TaskStatus,
    priority: 2,
    sortOrder: 1000,
    executionOrder: 7,
    assigneeAgentId: null,
    inputContext: {},
    dueAt: null,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  },
  {
    id: T.T11,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_AGENDO,
    title: 'Add GitHub issue sync for bidirectional task status updates',
    description: 'Webhook listener + polling: mirror task status ↔ GitHub issue state.',
    status: 'todo' as TaskStatus,
    priority: 3,
    sortOrder: 2000,
    executionOrder: 8,
    assigneeAgentId: AGENT_GEMINI,
    inputContext: { workingDir: '/home/ubuntu/projects/agendo' },
    dueAt: new Date('2026-04-28T00:00:00Z'),
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  },
  {
    id: T.T12,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_PLAYGROUND,
    title: 'Spike: evaluate Gemini 2.0 Flash for context-window summarisation',
    description:
      'Test token usage vs quality trade-off for session compaction using Gemini 2.0 Flash API.',
    status: 'todo' as TaskStatus,
    priority: 4,
    sortOrder: 1000,
    executionOrder: null,
    assigneeAgentId: AGENT_GEMINI,
    inputContext: { workingDir: '/tmp/spike-gemini' },
    dueAt: null,
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  },
  {
    id: T.T13,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_PLAYGROUND,
    title: 'Prototype multi-agent team orchestration with brainstorm rooms',
    description: 'Create a shared BrainstormRoom; wire wave mechanics and pass/converge signals.',
    status: 'todo' as TaskStatus,
    priority: 3,
    sortOrder: 2000,
    executionOrder: null,
    assigneeAgentId: null,
    inputContext: {},
    dueAt: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  {
    id: T.T14,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_OTHER_APP,
    title: 'Set up Vitest + Testing Library for the dashboard UI',
    description: 'Configure jsdom, MSW handlers, render helpers; add smoke tests for board view.',
    status: 'todo' as TaskStatus,
    priority: 3,
    sortOrder: 3000,
    executionOrder: null,
    assigneeAgentId: null,
    inputContext: {},
    dueAt: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  // ── CANCELLED (1) ─────────────────────────────────────────────────────────
  {
    id: T.T15,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: null,
    projectId: PROJECT_AGENDO,
    title: 'Migrate task storage from SQLite to DynamoDB',
    description:
      'Evaluated DynamoDB for task storage; cancelled — PostgreSQL fits the access patterns better.',
    status: 'cancelled' as TaskStatus,
    priority: 5,
    sortOrder: 1000,
    executionOrder: null,
    assigneeAgentId: null,
    inputContext: {},
    dueAt: null,
    createdAt: daysAgo(7),
    updatedAt: daysAgo(6),
  },
] satisfies readonly Task[];

// ============================================================================
// Internal helpers
// ============================================================================

/** Look up a single task by ID; throws NotFoundError if not found. */
function findTaskOrThrow(id: string): Task {
  const task = DEMO_TASKS.find((t) => t.id === id);
  if (!task) {
    throw new NotFoundError(`Task ${id} not found`);
  }
  return task;
}

/** Compute subtask totals for a given parent task ID. */
function computeSubtaskCounts(parentId: string): { total: number; done: number } {
  const children = DEMO_TASKS.filter((t) => t.parentTaskId === parentId);
  return {
    total: children.length,
    done: children.filter((t) => t.status === 'done').length,
  };
}

/** Attach subtask counts to a base Task row to produce a TaskBoardItem. */
function toTaskBoardItem(task: Task): TaskBoardItem {
  const { total, done } = computeSubtaskCounts(task.id);
  return { ...task, subtaskTotal: total, subtaskDone: done };
}

// ============================================================================
// Shadow exports — must match task-service.ts signatures exactly
// ============================================================================

export async function reindexColumn(_status: TaskStatus): Promise<void> {
  // No-op in demo mode — ordering is fixed in fixtures.
}

export async function listTasksBoardItems(
  _conditions: unknown[],
  _options: { limit?: number } = {},
): Promise<TaskBoardItem[]> {
  // In demo mode we ignore Drizzle SQL conditions entirely and return all fixtures.
  // Callers that need filtered results use their own JS-side filtering.
  return DEMO_TASKS.map(toTaskBoardItem);
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const now = new Date();
  const task: Task = {
    id: randomUUID(),
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    parentTaskId: input.parentTaskId ?? null,
    projectId: input.projectId ?? null,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? 'todo',
    priority: input.priority ?? 3,
    sortOrder: 1000,
    executionOrder: null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    inputContext: input.inputContext ?? {},
    dueAt: input.dueAt ?? null,
    createdAt: now,
    updatedAt: now,
  };
  return task;
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
  const existing = findTaskOrThrow(id);
  return {
    ...existing,
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.status !== undefined && { status: input.status }),
    ...(input.priority !== undefined && { priority: input.priority }),
    ...(input.assigneeAgentId !== undefined && { assigneeAgentId: input.assigneeAgentId }),
    ...(input.projectId !== undefined && { projectId: input.projectId }),
    ...(input.inputContext !== undefined && { inputContext: input.inputContext }),
    ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
    ...(input.parentTaskId !== undefined && { parentTaskId: input.parentTaskId }),
    ...(input.executionOrder !== undefined && { executionOrder: input.executionOrder }),
    updatedAt: new Date(),
  };
}

export async function deleteTask(_id: string): Promise<void> {
  // No-op: demo mode does not persist deletions.
}

export async function getTaskById(id: string): Promise<Task> {
  return findTaskOrThrow(id);
}

export async function getTaskWithDetails(id: string): Promise<TaskWithDetails> {
  const task = findTaskOrThrow(id);
  const { total, done } = computeSubtaskCounts(id);

  const assigneeRoster: Record<string, { id: string; name: string; slug: string }> = {
    [AGENT_CLAUDE]: { id: AGENT_CLAUDE, name: 'Claude', slug: 'claude' },
    [AGENT_CODEX]: { id: AGENT_CODEX, name: 'Codex', slug: 'codex' },
    [AGENT_GEMINI]: { id: AGENT_GEMINI, name: 'Gemini', slug: 'gemini' },
  };

  const assignee = task.assigneeAgentId ? (assigneeRoster[task.assigneeAgentId] ?? null) : null;

  const parentTask = task.parentTaskId
    ? (() => {
        const p = DEMO_TASKS.find((t) => t.id === task.parentTaskId);
        return p ? { id: p.id, title: p.title } : null;
      })()
    : null;

  return {
    ...task,
    subtaskCount: total,
    completedSubtaskCount: done,
    dependencyCount: 0,
    blockedByCount: 0,
    assignee,
    parentTask,
  };
}

export async function listTasksByStatus(
  options: ListTasksOptions,
): Promise<{ tasks: TaskBoardItem[]; nextCursor: string | null }> {
  const limit = options.limit ?? 50;

  let filtered = [...DEMO_TASKS];

  if (options.status) {
    filtered = filtered.filter((t) => t.status === options.status);
  }
  if (options.parentTaskId) {
    filtered = filtered.filter((t) => t.parentTaskId === options.parentTaskId);
  }
  if (options.projectId) {
    filtered = filtered.filter((t) => t.projectId === options.projectId);
  }
  if (options.q) {
    const q = options.q.toLowerCase();
    filtered = filtered.filter((t) => t.title.toLowerCase().includes(q));
  }
  if (options.cursor) {
    const cursorOrder = parseInt(options.cursor, 10);
    filtered = filtered.filter((t) => t.sortOrder > cursorOrder);
  }

  // Sort by sortOrder ascending (matches production behaviour)
  filtered.sort((a, b) => a.sortOrder - b.sortOrder);

  const hasMore = filtered.length > limit;
  const page = hasMore ? filtered.slice(0, limit) : filtered;
  const nextCursor = hasMore ? String(page[page.length - 1].sortOrder) : null;

  return { tasks: page.map(toTaskBoardItem), nextCursor };
}

export async function listSubtasks(parentTaskId: string): Promise<TaskBoardItem[]> {
  return DEMO_TASKS.filter((t) => t.parentTaskId === parentTaskId).map(toTaskBoardItem);
}

export async function searchTasks(q: string, limit = 5): Promise<SearchTaskResult[]> {
  const lower = q.toLowerCase();
  const projectNames: Record<string, string> = {
    [PROJECT_AGENDO]: 'agendo',
    [PROJECT_OTHER_APP]: 'my-other-app',
    [PROJECT_PLAYGROUND]: 'playground',
  };

  return DEMO_TASKS.filter(
    (t) =>
      t.title.toLowerCase().includes(lower) || (t.description ?? '').toLowerCase().includes(lower),
  )
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      projectName: t.projectId ? (projectNames[t.projectId] ?? null) : null,
    }));
}

/** Demo progress notes — one per in-progress or blocked task referencing a realistic note. */
const DEMO_PROGRESS_NOTES: Array<{
  taskId: string;
  note: string;
}> = [
  {
    taskId: T.T05,
    note: 'MCP tool handler for task_create implemented. Wire up routing next.',
  },
  {
    taskId: T.T06,
    note: 'Refactored session SSE handler to carry lastEventId on reconnect. Needs integration test.',
  },
  {
    taskId: T.T07,
    note: 'Cedar policy schema drafted for agent role scopes. Pending review from team.',
  },
  {
    taskId: T.T08,
    note: 'OTel spans wired in worker. Blocked on collector endpoint — ticket #447.',
  },
];

export async function searchProgressNotes(
  q: string,
  limit = 5,
): Promise<SearchProgressNoteResult[]> {
  const lower = q.toLowerCase();
  const projectNames: Record<string, string> = {
    [PROJECT_AGENDO]: 'agendo',
    [PROJECT_OTHER_APP]: 'my-other-app',
    [PROJECT_PLAYGROUND]: 'playground',
  };

  const results: SearchProgressNoteResult[] = [];

  for (const entry of DEMO_PROGRESS_NOTES) {
    if (!entry.note.toLowerCase().includes(lower)) continue;

    const task = DEMO_TASKS.find((t) => t.id === entry.taskId);
    if (!task) continue;

    const matchIdx = entry.note.toLowerCase().indexOf(lower);
    const start = Math.max(0, matchIdx - 30);
    const raw = entry.note.slice(start, start + 120);
    const noteSnippet = start > 0 ? `…${raw}` : raw;

    results.push({
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      projectName: task.projectId ? (projectNames[task.projectId] ?? null) : null,
      noteSnippet,
    });

    if (results.length >= limit) break;
  }

  return results;
}

export async function setExecutionOrder(_input: SetExecutionOrderInput): Promise<void> {
  // No-op: demo mode does not persist reordering.
}

export async function listReadyTasks(projectId?: string): Promise<TaskBoardItem[]> {
  // In demo mode we treat all 'todo' tasks as ready (no real dependency graph).
  let filtered = DEMO_TASKS.filter((t) => t.status === 'todo');

  if (projectId) {
    filtered = filtered.filter((t) => t.projectId === projectId);
  }

  // Sort: executionOrder ASC (nulls last), then sortOrder ASC — mirrors production.
  filtered = [...filtered].sort((a, b) => {
    const aOrder = a.executionOrder ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.executionOrder ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.sortOrder - b.sortOrder;
  });

  return filtered.map(toTaskBoardItem);
}

export async function reorderTask(id: string, input: ReorderTaskInput): Promise<Task> {
  const existing = findTaskOrThrow(id);
  return {
    ...existing,
    ...(input.status !== undefined && { status: input.status }),
    updatedAt: new Date(),
  };
}
