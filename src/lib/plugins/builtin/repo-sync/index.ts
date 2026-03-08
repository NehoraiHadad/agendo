/**
 * repo-sync plugin — Tracks git repositories associated with projects
 * and provides agents with tools to sync (git pull) them on demand.
 *
 * Extension points used:
 * - hooks: auto-track repos on project creation
 * - mcpTools: sync_repo tool for agents
 * - jobs: scheduled sync job
 * - store: persists tracked repo list
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants } from 'node:fs';
import type { AgendoPlugin, PluginContext } from '../../types';

const execFileAsync = promisify(execFile);

interface RepoEntry {
  path: string;
  branch: string | null;
  lastSync: string | null;
  lastError: string | null;
}

interface RepoSyncConfig {
  syncInterval?: string;
  autoPullOnProjectCreate?: boolean;
}

const manifest = {
  id: 'repo-sync',
  name: 'Repository Sync',
  description: 'Track and synchronize git repositories for projects. Provides agents with a sync_repo MCP tool.',
  version: '0.1.0',
  icon: 'git-branch',
  category: 'integration' as const,
  configSchema: {
    type: 'object' as const,
    properties: {
      syncInterval: {
        type: 'string' as const,
        description: 'Cron schedule for automatic sync (e.g., "0 */6 * * *")',
        default: '0 */6 * * *',
      },
      autoPullOnProjectCreate: {
        type: 'boolean' as const,
        description: 'Automatically track repos when a project is created',
        default: true,
      },
    },
  },
  defaultConfig: {
    syncInterval: '0 */6 * * *',
    autoPullOnProjectCreate: true,
  },
};

async function gitPull(repoPath: string): Promise<{ success: boolean; output: string }> {
  try {
    accessSync(repoPath, constants.R_OK);
  } catch {
    return { success: false, output: `Path not accessible: ${repoPath}` };
  }

  try {
    const { stdout, stderr } = await execFileAsync('git', ['pull', '--ff-only'], {
      cwd: repoPath,
      timeout: 60_000,
    });
    return { success: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg };
  }
}

async function getGitBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function isGitRepo(path: string): boolean {
  try {
    accessSync(`${path}/.git`, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const repoSyncPlugin: AgendoPlugin = {
  manifest,

  async activate(ctx: PluginContext) {
    const config = ctx.config as RepoSyncConfig;

    // Register MCP tool: sync_repo
    ctx.mcpTools.register({
      name: 'sync_repo',
      description:
        'Synchronize a git repository by running git pull. ' +
        'Provide the absolute path to the repo.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: {
            type: 'string',
            description: 'Absolute path to the git repository',
          },
        },
        required: ['repoPath'],
      },
      handler: async (input) => {
        const repoPath = input.repoPath as string;

        if (!isGitRepo(repoPath)) {
          return { success: false, error: `Not a git repository: ${repoPath}` };
        }

        const result = await gitPull(repoPath);

        // Update store with sync result
        const branch = await getGitBranch(repoPath);
        await ctx.store.set<RepoEntry>(`repos:${repoPath}`, {
          path: repoPath,
          branch,
          lastSync: result.success ? new Date().toISOString() : null,
          lastError: result.success ? null : result.output,
        });

        return result;
      },
    });

    // Register MCP tool: list_tracked_repos
    ctx.mcpTools.register({
      name: 'list_tracked_repos',
      description: 'List all git repositories being tracked by the repo-sync plugin.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const entries = await ctx.store.list('repos:');
        return entries.map(({ value }) => value);
      },
    });

    // Hook: auto-track repos when projects are created
    if (config.autoPullOnProjectCreate !== false) {
      ctx.hooks.on('project:created', async (payload) => {
        const project = payload as { id: string; rootPath?: string | null };
        if (!project.rootPath || !isGitRepo(project.rootPath)) return;

        const branch = await getGitBranch(project.rootPath);
        await ctx.store.set<RepoEntry>(`repos:${project.rootPath}`, {
          path: project.rootPath,
          branch,
          lastSync: null,
          lastError: null,
        });

        ctx.logger.info('Auto-tracked repo for new project', {
          projectId: project.id,
          repoPath: project.rootPath,
        });
      });
    }

    // Register scheduled sync job
    ctx.jobs.register(
      'sync-all',
      async () => {
        const entries = await ctx.store.list('repos:');
        let synced = 0;
        let failed = 0;

        for (const { key, value } of entries) {
          const entry = value as RepoEntry;
          const result = await gitPull(entry.path);

          if (result.success) {
            synced++;
            const branch = await getGitBranch(entry.path);
            await ctx.store.set<RepoEntry>(key, {
              ...entry,
              branch,
              lastSync: new Date().toISOString(),
              lastError: null,
            });
          } else {
            failed++;
            await ctx.store.set<RepoEntry>(key, {
              ...entry,
              lastError: result.output,
            });
          }
        }

        ctx.logger.info('Scheduled sync completed', { synced, failed });
      },
      { cron: config.syncInterval ?? '0 */6 * * *' },
    );

    ctx.logger.info('repo-sync plugin activated');
  },

  async deactivate() {
    // Hooks, jobs, and MCP tools are auto-cleaned by the registry
  },

  async onConfigChange(config: Record<string, unknown>) {
    // Job re-registration would happen here in phase 2
    // when job registry supports dynamic cron updates
    void config;
  },
};

export default repoSyncPlugin;
