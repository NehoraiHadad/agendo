/**
 * Demo-mode shadow for worker-config-service.
 *
 * Returns the same default values that the real service falls back to when
 * keys are not found in the database. This keeps worker logic consistent
 * in demo mode without a DB lookup.
 */

const DEFAULTS: Record<string, number> = {
  max_spawn_depth: 3,
  max_concurrent_ai_agents: 3,
  max_tasks_per_agent_per_minute: 10,
  log_retention_days: 30,
};

export async function getWorkerConfigNumber(key: string, fallback?: number): Promise<number> {
  return fallback ?? DEFAULTS[key] ?? 0;
}
