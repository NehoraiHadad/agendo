import { db, pool } from './index';
import { workerConfig } from './schema';

export async function seedWorkerConfig(): Promise<void> {
  await db
    .insert(workerConfig)
    .values([
      { key: 'log_retention_days', value: 30 },
      { key: 'max_concurrent_ai_agents', value: 3 },
    ])
    .onConflictDoNothing();

  console.log('[seed] Worker config seeded.');
}

seedWorkerConfig()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[seed] Error:', err);
    process.exit(1);
  });
