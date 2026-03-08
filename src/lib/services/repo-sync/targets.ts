/**
 * Repo-sync target registry
 *
 * All upstream repos that should be synced are defined here.
 * Add new entries to SYNC_TARGETS to register additional repos.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import type { SyncTarget } from './types';

// ─── Target definitions ─────────────────────────────────────────────────────

export const SYNC_TARGETS: SyncTarget[] = [
  {
    id: 'token-optimizer',
    repoUrl: 'https://github.com/alexgreensh/token-optimizer',
    branch: 'main',
    mappings: [
      {
        src: 'skills/token-optimizer',
        dest: path.join(os.homedir(), '.claude', 'skills', 'token-optimizer'),
      },
    ],
    enabled: true,
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Look up a sync target by ID. */
export function getTarget(id: string): SyncTarget | undefined {
  return SYNC_TARGETS.find((t) => t.id === id);
}

/** List all enabled targets. */
export function getEnabledTargets(): SyncTarget[] {
  return SYNC_TARGETS.filter((t) => t.enabled);
}
