/**
 * Demo-mode shadow for github-sync-service.
 *
 * All GitHub sync operations are no-ops or return empty results.
 * This service is worker/runtime-only plumbing — not reached from the UI
 * in demo mode. Thin shadow prevents crashes if transitively invoked.
 */

import type { SyncResult } from './github-sync-service';
import type { Project } from '@/lib/types';
import type { Octokit } from '@octokit/rest';

export async function syncInbound(_octokit: Octokit, project: Project): Promise<SyncResult> {
  return {
    projectId: project.id,
    repo: project.githubRepo ?? '',
    tasksCreated: 0,
    tasksUpdated: 0,
    commentsSynced: 0,
    errors: [],
  };
}

export async function syncTaskStatusToGitHub(
  _task: unknown,
  _fromStatus: string,
  _toStatus: string,
): Promise<void> {
  // No-op in demo mode.
}

export async function syncProgressNoteToGitHub(_taskId: string, _note: string): Promise<void> {
  // No-op in demo mode.
}

export async function createGitHubIssueForTask(
  _taskId: string,
): Promise<{ issueNumber: number; issueUrl: string } | null> {
  return null;
}

export async function runGitHubSync(): Promise<SyncResult[]> {
  return [];
}

export async function getGitHubSyncStatus(
  _projectId: string,
): Promise<{ connected: boolean; repo: string | null; lastSyncAt: Date | null } | null> {
  return { connected: false, repo: null, lastSyncAt: null };
}
