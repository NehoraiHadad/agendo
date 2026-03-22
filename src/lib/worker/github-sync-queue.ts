import { getBoss } from './queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('github-sync-queue');

export const GITHUB_SYNC_QUEUE_NAME = 'github-sync';
const GITHUB_SYNC_CRON = '*/5 * * * *'; // Every 5 minutes

export interface GitHubSyncJobData {
  /** If set, sync only this project. Otherwise sync all connected projects. */
  projectId?: string;
}

/**
 * Register the GitHub sync scheduled job.
 * Runs every 5 minutes to poll GitHub for new/updated issues.
 */
export async function registerGitHubSyncSchedule(): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(GITHUB_SYNC_QUEUE_NAME);

  // pg-boss v10 schedule: creates a cron-based recurring job
  await boss.schedule(
    GITHUB_SYNC_QUEUE_NAME,
    GITHUB_SYNC_CRON,
    {},
    {
      retryLimit: 0, // Don't retry failed syncs — next cron will pick up
      expireInMinutes: 4, // Must complete before next run
      singletonKey: 'github-sync-global', // Only one sync job at a time
    },
  );

  log.info({ cron: GITHUB_SYNC_CRON }, 'GitHub sync schedule registered');
}

/**
 * Register the worker handler for GitHub sync jobs.
 */
export async function registerGitHubSyncWorker(
  handler: (data: GitHubSyncJobData) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();

  await boss.work<GitHubSyncJobData>(GITHUB_SYNC_QUEUE_NAME, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handler(job.data);
    }
  });
}

/**
 * Manually trigger a GitHub sync (e.g. from API).
 */
export async function enqueueGitHubSync(data: GitHubSyncJobData = {}): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(GITHUB_SYNC_QUEUE_NAME, data, {
    expireInMinutes: 4,
    singletonKey: data.projectId ?? 'github-sync-manual',
  });
}
