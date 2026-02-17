import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { workerConfig } from '@/lib/db/schema';

const DEFAULTS: Record<string, number> = {
  max_spawn_depth: 3,
  max_concurrent_ai_agents: 3,
  max_tasks_per_agent_per_minute: 10,
  log_retention_days: 30,
};

export async function getWorkerConfigNumber(key: string, fallback?: number): Promise<number> {
  const [row] = await db
    .select({ value: workerConfig.value })
    .from(workerConfig)
    .where(eq(workerConfig.key, key))
    .limit(1);

  if (row) {
    const num = Number(row.value);
    if (!isNaN(num)) return num;
  }

  return fallback ?? DEFAULTS[key] ?? 0;
}
