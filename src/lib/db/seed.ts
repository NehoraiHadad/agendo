import { db, pool } from './index';
import { workerConfig } from './schema';
import { createLogger } from '@/lib/logger';
import { runDiscovery } from '@/lib/discovery';
import {
  createFromDiscovery,
  getExistingSlugs,
  getExistingBinaryPaths,
} from '@/lib/services/agent-service';
import { getOrCreateSystemProject } from '@/lib/services/project-service';

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

async function seedAgents(): Promise<void> {
  log.info('Discovering AI agent CLIs...');
  const existingSlugs = await getExistingSlugs();
  const existingBinaryPaths = await getExistingBinaryPaths();
  const discovered = await runDiscovery(undefined, existingSlugs, existingBinaryPaths);

  if (discovered.length === 0) {
    console.log(
      "  \u26A0 No AI agent CLIs found in PATH. Install claude, codex, or gemini and run 'pnpm db:seed' again.",
    );
    return;
  }

  for (const tool of discovered) {
    await createFromDiscovery(tool);
    const capCount = tool.preset?.defaultCapabilities.length ?? 0;
    const wasExisting = tool.isConfirmed ? ' (already registered)' : '';
    console.log(
      `  \u2713 Discovered: ${tool.name} at ${tool.path} \u2014 registered with ${capCount} capability${capCount !== 1 ? 'ies' : ''}${wasExisting}`,
    );
  }

  log.info({ count: discovered.length }, 'Agent discovery complete');
}

async function seed(): Promise<void> {
  await seedWorkerConfig();
  await seedAgents();
  const sys = await getOrCreateSystemProject();
  log.info({ id: sys.id, rootPath: sys.rootPath }, 'System project ready');
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    log.error({ err }, 'Seed error');
    process.exit(1);
  });
