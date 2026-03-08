/**
 * Repo-sync engine — core sync logic
 *
 * Clones upstream repos (shallow), compares with local state via manifest,
 * and copies changed files to their configured destinations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { SyncTarget, SyncManifest, SyncRecord, SyncResult, SyncFileResult } from './types';

// ─── Manifest I/O ───────────────────────────────────────────────────────────

const EMPTY_MANIFEST: SyncManifest = { version: 1, records: [] };

/** Load the sync manifest from disk. Returns empty manifest if missing. */
export function loadManifest(manifestPath: string): SyncManifest {
  if (!fs.existsSync(manifestPath)) return { ...EMPTY_MANIFEST, records: [] };
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as SyncManifest;
}

/** Persist the sync manifest to disk, creating parent dirs if needed. */
export function saveManifest(manifestPath: string, manifest: SyncManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// ─── Git helpers ────────────────────────────────────────────────────────────

/** Get the HEAD commit SHA of a local git clone. */
export function getHeadCommit(clonePath: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: clonePath,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`git rev-parse failed (exit ${result.status}): ${result.stderr ?? ''}`.trim());
  }
  return result.stdout.trim();
}

/** Shallow-clone a repo at a specific branch. */
export function cloneRepo(repoUrl: string, branch: string, destPath: string): void {
  const result = spawnSync('git', ['clone', '--depth=1', '--branch', branch, repoUrl, destPath], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`Clone failed (exit ${result.status}): ${result.stderr ?? ''}`.trim());
  }
}

// ─── File operations ────────────────────────────────────────────────────────

/** Recursively list all files under a directory, returning paths relative to it. */
function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];

  function walk(current: string, prefix: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), rel);
      } else {
        results.push(rel);
      }
    }
  }

  walk(dir, '');
  return results;
}

/** Compare source and dest file content. Returns true if they differ. */
function filesDiffer(srcFile: string, destFile: string): boolean {
  if (!fs.existsSync(destFile)) return true;
  const srcBuf = fs.readFileSync(srcFile);
  const destBuf = fs.readFileSync(destFile);
  return !srcBuf.equals(destBuf);
}

// ─── Core sync ──────────────────────────────────────────────────────────────

/**
 * Sync a single target: clone, compare, copy changed files, update manifest.
 *
 * This function catches errors internally and returns them in `result.error`
 * so callers can process multiple targets without one failure aborting the rest.
 */
export function syncTarget(target: SyncTarget, manifestPath: string): SyncResult {
  // Short-circuit disabled targets
  if (!target.enabled) {
    return {
      targetId: target.id,
      changed: false,
      commit: '',
      previousCommit: null,
      files: [],
    };
  }

  const cloneDir = path.join(os.tmpdir(), `repo-sync-${target.id}-${Date.now()}`);

  try {
    // 1. Clone upstream
    cloneRepo(target.repoUrl, target.branch, cloneDir);

    // 2. Get upstream commit
    const commit = getHeadCommit(cloneDir);

    // 3. Load manifest and find previous record
    const manifest = loadManifest(manifestPath);
    const prevRecord = manifest.records.find((r) => r.targetId === target.id);
    const previousCommit = prevRecord?.lastCommit ?? null;

    // 4. Skip if commit hasn't changed
    if (previousCommit === commit) {
      return {
        targetId: target.id,
        changed: false,
        commit,
        previousCommit,
        files: [],
      };
    }

    // 5. Process each mapping
    const allFiles: SyncFileResult[] = [];
    const allSyncedFiles: string[] = [];

    for (const mapping of target.mappings) {
      const srcDir = path.join(cloneDir, mapping.src);
      const destDir = mapping.dest;

      if (!fs.existsSync(srcDir)) {
        continue; // Source path doesn't exist in upstream — skip
      }

      // List upstream files
      const upstreamFiles = listFilesRecursive(srcDir);
      const previousFiles = new Set(prevRecord?.syncedFiles ?? []);

      // Ensure dest dir exists
      fs.mkdirSync(destDir, { recursive: true });

      // Copy/update files
      for (const relPath of upstreamFiles) {
        const srcFile = path.join(srcDir, relPath);
        const destFile = path.join(destDir, relPath);

        const isNew = !previousFiles.has(relPath) && !fs.existsSync(destFile);
        const isUpdated = !isNew && filesDiffer(srcFile, destFile);

        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.cpSync(srcFile, destFile);

        if (isNew) {
          allFiles.push({ relativePath: relPath, action: 'added' });
        } else if (isUpdated) {
          allFiles.push({ relativePath: relPath, action: 'updated' });
        } else {
          allFiles.push({ relativePath: relPath, action: 'unchanged' });
        }

        allSyncedFiles.push(relPath);
      }

      // Remove files that were previously synced but no longer exist upstream
      for (const oldFile of previousFiles) {
        if (!upstreamFiles.includes(oldFile)) {
          const destFile = path.join(destDir, oldFile);
          if (fs.existsSync(destFile)) {
            fs.rmSync(destFile);
            allFiles.push({ relativePath: oldFile, action: 'removed' });
          }
        }
      }
    }

    const changed = allFiles.some((f) => f.action !== 'unchanged');

    // 6. Update manifest
    const newRecord: SyncRecord = {
      targetId: target.id,
      lastCommit: commit,
      lastSyncedAt: new Date().toISOString(),
      syncedFiles: allSyncedFiles,
    };

    const updatedRecords = manifest.records.filter((r) => r.targetId !== target.id);
    updatedRecords.push(newRecord);
    saveManifest(manifestPath, { version: 1, records: updatedRecords });

    return {
      targetId: target.id,
      changed,
      commit,
      previousCommit,
      files: allFiles,
    };
  } catch (err) {
    return {
      targetId: target.id,
      changed: false,
      commit: '',
      previousCommit: null,
      files: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Clean up clone dir
    fs.rmSync(cloneDir, { recursive: true, force: true });
  }
}

/**
 * Sync all targets in a registry. Returns results for each target.
 */
export function syncAll(targets: SyncTarget[], manifestPath: string): SyncResult[] {
  return targets.map((t) => syncTarget(t, manifestPath));
}
