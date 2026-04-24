/**
 * Demo-mode shadow for dependency-service.ts.
 *
 * All exported functions mirror the real service's signatures exactly, but
 * operate entirely on in-memory fixtures — no database access.
 *
 * `addDependency` returns a typed stub row; `removeDependency` is a no-op.
 *
 * Imported only via dynamic `await import('./dependency-service.demo')` in demo
 * mode so it is tree-shaken from production bundles.
 */

import { DEMO_TASKS } from '@/lib/services/task-service.demo';

// ============================================================================
// Canonical task IDs (Agent A's range)
// ============================================================================

const T03 = 'aaaaaaaa-aaaa-4003-a003-aaaaaaaaaaaa';
const T04 = 'aaaaaaaa-aaaa-4004-a004-aaaaaaaaaaaa';
const T05 = 'aaaaaaaa-aaaa-4005-a005-aaaaaaaaaaaa';
const T06 = 'aaaaaaaa-aaaa-4006-a006-aaaaaaaaaaaa';

// Fixed reference point for deterministic timestamps
const NOW = new Date('2026-04-23T10:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

// ============================================================================
// Dependency edges fixture
// Semantics: taskId depends on dependsOnTaskId (dependsOnTaskId blocks taskId)
// ============================================================================

interface DependencyRow {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: Date;
}

const DEMO_DEPENDENCIES: readonly DependencyRow[] = [
  // task-4004 is blocked by (depends on) task-4003
  { taskId: T04, dependsOnTaskId: T03, createdAt: daysAgo(5) },
  // task-4006 is blocked by (depends on) task-4005
  { taskId: T06, dependsOnTaskId: T05, createdAt: daysAgo(3) },
];

// ============================================================================
// Internal helper — look up task summary from DEMO_TASKS
// ============================================================================

function findTaskSummary(id: string): { id: string; title: string; status: string } | null {
  const t = DEMO_TASKS.find((task) => task.id === id);
  if (!t) return null;
  return { id: t.id, title: t.title, status: t.status };
}

// ============================================================================
// Shadow exports — must match dependency-service.ts signatures exactly
// ============================================================================

export async function addDependency(
  taskId: string,
  dependsOnTaskId: string,
): Promise<DependencyRow> {
  return { taskId, dependsOnTaskId, createdAt: new Date() };
}

export async function removeDependency(_taskId: string, _dependsOnTaskId: string): Promise<void> {
  // No-op: demo mode does not persist deletions.
}

/**
 * List all tasks that a given task depends on (its blockers).
 */
export async function listDependencies(
  taskId: string,
): Promise<Array<{ id: string; title: string; status: string }>> {
  return DEMO_DEPENDENCIES.filter((d) => d.taskId === taskId)
    .map((d) => findTaskSummary(d.dependsOnTaskId))
    .filter((t): t is { id: string; title: string; status: string } => t !== null);
}

/**
 * List all tasks that depend on a given task (tasks it blocks).
 */
export async function listDependents(
  taskId: string,
): Promise<Array<{ id: string; title: string; status: string }>> {
  return DEMO_DEPENDENCIES.filter((d) => d.dependsOnTaskId === taskId)
    .map((d) => findTaskSummary(d.taskId))
    .filter((t): t is { id: string; title: string; status: string } => t !== null);
}
