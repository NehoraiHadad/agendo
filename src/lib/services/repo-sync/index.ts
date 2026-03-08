/**
 * Repo-sync service — public API
 *
 * Provides utilities for syncing files from upstream Git repositories
 * into the local project tree. Tracks sync state via a JSON manifest.
 */

export type {
  SyncTarget,
  SyncMapping,
  SyncManifest,
  SyncRecord,
  SyncResult,
  SyncFileResult,
  SyncFileAction,
} from './types';

export { syncTarget, syncAll, loadManifest, saveManifest } from './sync-engine';
export { SYNC_TARGETS, getTarget, getEnabledTargets } from './targets';

/** Default manifest location within the project. */
export const DEFAULT_MANIFEST_PATH = '.repo-sync-manifest.json';
