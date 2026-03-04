import { db, pool } from './index';
import { workerConfig } from './schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('seed');

export async function seedWorkerConfig(): Promise<void> {
  await db
    .insert(workerConfig)
    .values([
      { key: 'log_retention_days', value: 30 },
      { key: 'max_concurrent_ai_agents', value: 3 },
      { key: 'max_spawn_depth', value: 3 },
      { key: 'max_tasks_per_agent_per_minute', value: 10 },
    ])
    .onConflictDoNothing();

  log.info('Worker config seeded');
}

seedWorkerConfig()
  .then(() => pool.end())
  .catch((err) => {
    log.error({ err }, 'Seed error');
    process.exit(1);
  });
