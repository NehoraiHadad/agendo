import { eq, and, sql } from 'drizzle-orm';
import type { Octokit } from '@octokit/rest';
import { db } from '@/lib/db';
import { projects, tasks } from '@/lib/db/schema';
import { getOctokit } from '@/lib/services/github-service';
import { createTask, updateTask, getTaskById } from '@/lib/services/task-service';
import { createLogger } from '@/lib/logger';
import type { Project, Task, TaskStatus } from '@/lib/types';
import { isDemoMode } from '@/lib/demo/flag';

const log = createLogger('github-sync');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncResult {
  projectId: string;
  repo: string;
  tasksCreated: number;
  tasksUpdated: number;
  commentsSynced: number;
  errors: string[];
}

/** Map GitHub labels to Agendo priority (1=highest, 5=lowest). */
function labelsToPriority(labels: Array<{ name?: string }>): number {
  const names = labels.map((l) => l.name?.toLowerCase() ?? '');
  if (names.includes('critical') || names.includes('p0')) return 1;
  if (names.includes('high') || names.includes('p1')) return 2;
  if (names.includes('medium') || names.includes('p2')) return 3;
  if (names.includes('low') || names.includes('p3')) return 4;
  if (names.includes('trivial') || names.includes('p4')) return 5;
  return 3; // default medium
}

/** Map GitHub issue state to initial Agendo task status. */
function issueStateToStatus(state: string): TaskStatus {
  return state === 'closed' ? 'done' : 'todo';
}

// ---------------------------------------------------------------------------
// Inbound sync: GitHub → Agendo
// ---------------------------------------------------------------------------

/**
 * Find an existing Agendo task linked to a GitHub issue number within a project.
 */
async function findTaskByIssueNumber(projectId: string, issueNumber: number): Promise<Task | null> {
  // Use JSONB operator to match inputContext.githubIssueNumber
  const [task] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        sql`${tasks.inputContext}->>'githubIssueNumber' = ${String(issueNumber)}`,
      ),
    )
    .limit(1);
  return task ?? null;
}

/**
 * Sync a single GitHub issue into an Agendo task.
 * Creates or updates as needed. Returns the task.
 */
async function syncIssueToTask(
  project: Project,
  issue: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    html_url: string;
    labels: Array<{ name?: string }>;
  },
): Promise<{ task: Task; created: boolean }> {
  const existing = await findTaskByIssueNumber(project.id, issue.number);

  if (existing) {
    // Update existing task if GitHub issue changed
    const newStatus = issueStateToStatus(issue.state);
    const updates: Record<string, unknown> = {};
    let needsUpdate = false;

    if (existing.title !== issue.title) {
      updates.title = issue.title;
      needsUpdate = true;
    }
    if (existing.description !== issue.body) {
      updates.description = issue.body;
      needsUpdate = true;
    }

    // Only update status if issue was closed and task isn't already done/cancelled
    if (newStatus === 'done' && existing.status !== 'done' && existing.status !== 'cancelled') {
      // Must go through in_progress first if currently todo
      if (existing.status === 'todo') {
        await updateTask(existing.id, { status: 'in_progress' });
      }
      updates.status = 'done' as TaskStatus;
      needsUpdate = true;
    }

    // Reopen task if issue was reopened
    if (issue.state === 'open' && existing.status === 'done') {
      updates.status = 'todo' as TaskStatus;
      needsUpdate = true;
    }

    if (needsUpdate) {
      const updated = await updateTask(existing.id, updates as Parameters<typeof updateTask>[1]);
      return { task: updated, created: false };
    }
    return { task: existing, created: false };
  }

  // Create new task from GitHub issue
  const status = issueStateToStatus(issue.state);
  const task = await createTask({
    title: issue.title,
    description: issue.body ?? undefined,
    projectId: project.id,
    priority: labelsToPriority(issue.labels),
    status: status === 'done' ? 'todo' : status, // Create as todo; we'll transition below
    inputContext: {
      githubIssueNumber: issue.number,
      githubIssueUrl: issue.html_url,
    },
  });

  // If the issue was already closed, transition through in_progress → done
  if (status === 'done') {
    await updateTask(task.id, { status: 'in_progress' });
    await updateTask(task.id, { status: 'done' });
  }

  return { task, created: true };
}

/**
 * Run inbound sync for a single project: fetch recent GitHub issues and sync to Agendo.
 */
export async function syncInbound(octokit: Octokit, project: Project): Promise<SyncResult> {
  if (isDemoMode()) {
    const demo = await import('./github-sync-service.demo');
    return demo.syncInbound(octokit, project);
  }
  const ghRepo = project.githubRepo ?? '';
  const result: SyncResult = {
    projectId: project.id,
    repo: ghRepo,
    tasksCreated: 0,
    tasksUpdated: 0,
    commentsSynced: 0,
    errors: [],
  };

  const [owner, repo] = ghRepo.split('/');

  try {
    // Fetch issues updated since last sync cursor
    const since = project.githubSyncCursor?.toISOString();
    const { data: issuesList } = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      ...(since ? { since } : {}),
    });

    // Filter out pull requests (GitHub API returns them as issues too)
    const issues = issuesList.filter((i) => !i.pull_request);

    for (const issue of issues) {
      try {
        const { created } = await syncIssueToTask(project, {
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          state: issue.state,
          html_url: issue.html_url,
          labels: issue.labels.map((l) =>
            typeof l === 'string' ? { name: l } : { name: l.name ?? undefined },
          ),
        });

        if (created) {
          result.tasksCreated++;
        } else {
          result.tasksUpdated++;
        }
      } catch (err) {
        const msg = `Failed to sync issue #${issue.number}: ${err instanceof Error ? err.message : String(err)}`;
        log.error({ err, issueNumber: issue.number }, msg);
        result.errors.push(msg);
      }
    }

    // Update sync cursor to now
    await db
      .update(projects)
      .set({ githubSyncCursor: new Date(), updatedAt: new Date() })
      .where(eq(projects.id, project.id));
  } catch (err) {
    const msg = `Failed to fetch issues from ${project.githubRepo}: ${err instanceof Error ? err.message : String(err)}`;
    log.error({ err, repo: project.githubRepo }, msg);
    result.errors.push(msg);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Outbound sync: Agendo → GitHub
// ---------------------------------------------------------------------------

/**
 * Post a status change comment on the linked GitHub issue.
 */
export async function syncTaskStatusToGitHub(
  task: Task,
  fromStatus: string,
  toStatus: string,
): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./github-sync-service.demo');
    return demo.syncTaskStatusToGitHub(task, fromStatus, toStatus);
  }
  if (!task.projectId || !task.inputContext.githubIssueNumber) return;

  const octokit = await getOctokit();
  if (!octokit) return;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, task.projectId))
    .limit(1);
  if (!project?.githubRepo) return;

  const [owner, repo] = project.githubRepo.split('/');
  const issueNumber = task.inputContext.githubIssueNumber;

  try {
    // Post status change comment
    const statusEmoji: Record<string, string> = {
      in_progress: '🔄',
      done: '✅',
      blocked: '🚫',
      cancelled: '❌',
      todo: '📋',
    };
    const emoji = statusEmoji[toStatus] ?? '📌';
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `${emoji} **Agendo**: Task status changed: \`${fromStatus}\` → \`${toStatus}\``,
    });

    // Close/reopen issue based on status
    if (toStatus === 'done' || toStatus === 'cancelled') {
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        state: 'closed',
        state_reason: toStatus === 'done' ? 'completed' : 'not_planned',
      });
    } else if (fromStatus === 'done' || fromStatus === 'cancelled') {
      // Reopen if task was re-activated
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        state: 'open',
      });
    }

    // Update labels for status tracking
    const statusLabels = ['agendo:todo', 'agendo:in-progress', 'agendo:blocked', 'agendo:done'];
    const newLabel = `agendo:${toStatus.replace('_', '-')}`;

    // Remove old agendo status labels
    for (const label of statusLabels) {
      try {
        await octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number: issueNumber,
          name: label,
        });
      } catch {
        // Label may not exist, that's fine
      }
    }

    // Add new status label (create if it doesn't exist)
    try {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: [newLabel],
      });
    } catch {
      // If label doesn't exist, create it first
      try {
        const labelColors: Record<string, string> = {
          'agendo:todo': 'e4e669',
          'agendo:in-progress': '0075ca',
          'agendo:blocked': 'd73a4a',
          'agendo:done': '0e8a16',
        };
        await octokit.rest.issues.createLabel({
          owner,
          repo,
          name: newLabel,
          color: labelColors[newLabel] ?? '6f42c1',
          description: `Agendo task status: ${toStatus}`,
        });
        await octokit.rest.issues.addLabels({
          owner,
          repo,
          issue_number: issueNumber,
          labels: [newLabel],
        });
      } catch (labelErr) {
        log.debug({ err: labelErr, label: newLabel }, 'Could not create/add label');
      }
    }

    log.info(
      { issueNumber, fromStatus, toStatus, repo: project.githubRepo },
      'Synced task status to GitHub',
    );
  } catch (err) {
    log.error({ err, issueNumber, repo: project.githubRepo }, 'Failed to sync status to GitHub');
  }
}

/**
 * Post a progress note as a comment on the linked GitHub issue.
 */
export async function syncProgressNoteToGitHub(taskId: string, note: string): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./github-sync-service.demo');
    return demo.syncProgressNoteToGitHub(taskId, note);
  }
  let task: Task;
  try {
    task = await getTaskById(taskId);
  } catch {
    return;
  }

  if (!task.projectId || !task.inputContext.githubIssueNumber) return;

  const octokit = await getOctokit();
  if (!octokit) return;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, task.projectId))
    .limit(1);
  if (!project?.githubRepo) return;

  const [owner, repo] = project.githubRepo.split('/');

  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: task.inputContext.githubIssueNumber,
      body: `🤖 **Agent update:**\n\n${note}`,
    });
    log.debug(
      { taskId, issueNumber: task.inputContext.githubIssueNumber },
      'Synced progress note to GitHub',
    );
  } catch (err) {
    log.error({ err, taskId }, 'Failed to sync progress note to GitHub');
  }
}

/**
 * Create a new GitHub issue for an Agendo task.
 * Updates the task's inputContext with the issue number and URL.
 */
export async function createGitHubIssueForTask(
  taskId: string,
): Promise<{ issueNumber: number; issueUrl: string } | null> {
  if (isDemoMode()) {
    const demo = await import('./github-sync-service.demo');
    return demo.createGitHubIssueForTask(taskId);
  }
  const task = await getTaskById(taskId);
  if (!task.projectId) return null;
  if (task.inputContext.githubIssueNumber) return null; // Already linked

  const octokit = await getOctokit();
  if (!octokit) return null;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, task.projectId))
    .limit(1);
  if (!project?.githubRepo) return null;

  const [owner, repo] = project.githubRepo.split('/');

  try {
    const { data: issue } = await octokit.rest.issues.create({
      owner,
      repo,
      title: task.title,
      body: task.description ?? undefined,
    });

    // Update task with GitHub issue link
    await updateTask(taskId, {
      inputContext: {
        ...task.inputContext,
        githubIssueNumber: issue.number,
        githubIssueUrl: issue.html_url,
      },
    });

    log.info(
      { taskId, issueNumber: issue.number, repo: project.githubRepo },
      'Created GitHub issue for task',
    );
    return { issueNumber: issue.number, issueUrl: issue.html_url };
  } catch (err) {
    log.error({ err, taskId, repo: project.githubRepo }, 'Failed to create GitHub issue');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full sync job (called by worker)
// ---------------------------------------------------------------------------

/**
 * Run a full bidirectional sync for all connected projects.
 * Called by the worker's setInterval sync loop.
 */
export async function runGitHubSync(): Promise<SyncResult[]> {
  if (isDemoMode()) {
    const demo = await import('./github-sync-service.demo');
    return demo.runGitHubSync();
  }
  const octokit = await getOctokit();
  if (!octokit) {
    log.debug('No GitHub token available, skipping sync');
    return [];
  }

  // Find all active projects with a GitHub repo configured
  const connectedProjects = await db
    .select()
    .from(projects)
    .where(and(eq(projects.isActive, true), sql`${projects.githubRepo} IS NOT NULL`));

  if (connectedProjects.length === 0) {
    log.debug('No GitHub-connected projects found');
    return [];
  }

  const results: SyncResult[] = [];
  for (const project of connectedProjects) {
    try {
      const result = await syncInbound(octokit, project);
      results.push(result);
      log.info(
        {
          projectId: project.id,
          repo: project.githubRepo,
          created: result.tasksCreated,
          updated: result.tasksUpdated,
          errors: result.errors.length,
        },
        'GitHub sync completed for project',
      );
    } catch (err) {
      log.error({ err, projectId: project.id, repo: project.githubRepo }, 'GitHub sync failed');
      results.push({
        projectId: project.id,
        repo: project.githubRepo ?? '',
        tasksCreated: 0,
        tasksUpdated: 0,
        commentsSynced: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return results;
}

/**
 * Get sync status for a project.
 */
export async function getGitHubSyncStatus(projectId: string): Promise<{
  connected: boolean;
  repo: string | null;
  lastSyncAt: Date | null;
} | null> {
  if (isDemoMode()) {
    const demo = await import('./github-sync-service.demo');
    return demo.getGitHubSyncStatus(projectId);
  }
  const [project] = await db
    .select({
      githubRepo: projects.githubRepo,
      githubSyncCursor: projects.githubSyncCursor,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) return null;

  return {
    connected: !!project.githubRepo,
    repo: project.githubRepo,
    lastSyncAt: project.githubSyncCursor,
  };
}
