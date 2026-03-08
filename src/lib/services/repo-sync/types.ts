/**
 * Modular repo-sync service — types
 *
 * Defines the configuration and result types for syncing files from
 * upstream Git repositories into the Agendo project tree.
 */

// ─── Configuration ──────────────────────────────────────────────────────────

/** A single file/directory mapping from upstream repo to local destination. */
export interface SyncMapping {
  /** Path within the cloned repo (e.g. "skills/token-optimizer") */
  src: string;
  /** Absolute or project-relative destination path */
  dest: string;
}

/** Defines an upstream repo to sync from. */
export interface SyncTarget {
  /** Unique identifier for this sync target (e.g. "token-optimizer") */
  id: string;
  /** Git clone URL (HTTPS or SSH) */
  repoUrl: string;
  /** Branch to sync from (default: "main") */
  branch: string;
  /** File/directory mappings from repo to local paths */
  mappings: SyncMapping[];
  /** Whether this target is enabled for periodic sync */
  enabled: boolean;
}

// ─── Manifest (tracks sync state) ───────────────────────────────────────────

/** Per-target sync state, persisted in the manifest file. */
export interface SyncRecord {
  /** SyncTarget.id */
  targetId: string;
  /** Commit SHA of last successful sync */
  lastCommit: string;
  /** ISO 8601 timestamp of last successful sync */
  lastSyncedAt: string;
  /** Files that were synced (relative to dest) */
  syncedFiles: string[];
}

/** On-disk manifest tracking all sync state. */
export interface SyncManifest {
  version: 1;
  records: SyncRecord[];
}

// ─── Results ────────────────────────────────────────────────────────────────

export type SyncFileAction = 'added' | 'updated' | 'removed' | 'unchanged';

export interface SyncFileResult {
  /** Relative path within the destination */
  relativePath: string;
  action: SyncFileAction;
}

export interface SyncResult {
  targetId: string;
  /** Whether any files changed */
  changed: boolean;
  /** Upstream commit SHA that was synced */
  commit: string;
  /** Previous commit SHA (null on first sync) */
  previousCommit: string | null;
  /** Per-file results */
  files: SyncFileResult[];
  /** Error message if sync failed */
  error?: string;
}
