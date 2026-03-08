#!/usr/bin/env -S bun run
/**
 * Repo-sync CLI
 *
 * Syncs upstream repos defined in src/lib/services/repo-sync/targets.ts.
 *
 * Usage:
 *   bun scripts/repo-sync.ts                  # sync all enabled targets
 *   bun scripts/repo-sync.ts token-optimizer  # sync a specific target
 *   bun scripts/repo-sync.ts --list           # list configured targets
 *   bun scripts/repo-sync.ts --status         # show sync status from manifest
 */

import * as path from 'node:path';
import {
  syncTarget,
  syncAll,
  loadManifest,
  getTarget,
  getEnabledTargets,
  SYNC_TARGETS,
  DEFAULT_MANIFEST_PATH,
} from '../src/lib/services/repo-sync';
import type { SyncResult } from '../src/lib/services/repo-sync';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(PROJECT_ROOT, DEFAULT_MANIFEST_PATH);

// ─── ANSI colors ────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// ─── Output helpers ─────────────────────────────────────────────────────────

function printResult(result: SyncResult): void {
  const prefix = result.error
    ? `${RED}✗${RESET}`
    : result.changed
      ? `${GREEN}✓${RESET}`
      : `${DIM}—${RESET}`;

  console.log(`${prefix} ${BOLD}${result.targetId}${RESET}`);

  if (result.error) {
    console.log(`  ${RED}Error: ${result.error}${RESET}`);
    return;
  }

  if (!result.changed) {
    console.log(`  ${DIM}No changes (commit: ${result.commit.slice(0, 8)})${RESET}`);
    return;
  }

  console.log(
    `  ${CYAN}${result.previousCommit?.slice(0, 8) ?? '(first sync)'} → ${result.commit.slice(0, 8)}${RESET}`,
  );

  for (const file of result.files) {
    if (file.action === 'unchanged') continue;
    const color = file.action === 'added' ? GREEN : file.action === 'updated' ? YELLOW : RED;
    const symbol = file.action === 'added' ? '+' : file.action === 'updated' ? '~' : '-';
    console.log(`  ${color}${symbol} ${file.relativePath}${RESET}`);
  }
}

// ─── Commands ───────────────────────────────────────────────────────────────

function listTargets(): void {
  console.log(`${BOLD}Configured sync targets:${RESET}\n`);
  for (const t of SYNC_TARGETS) {
    const status = t.enabled ? `${GREEN}enabled${RESET}` : `${DIM}disabled${RESET}`;
    console.log(`  ${BOLD}${t.id}${RESET} [${status}]`);
    console.log(`    repo:   ${t.repoUrl}`);
    console.log(`    branch: ${t.branch}`);
    for (const m of t.mappings) {
      console.log(`    ${m.src} → ${m.dest}`);
    }
    console.log();
  }
}

function showStatus(): void {
  const manifest = loadManifest(MANIFEST);
  console.log(`${BOLD}Sync status:${RESET}\n`);

  if (manifest.records.length === 0) {
    console.log(`  ${DIM}No syncs recorded yet.${RESET}`);
    return;
  }

  for (const record of manifest.records) {
    console.log(`  ${BOLD}${record.targetId}${RESET}`);
    console.log(`    commit:  ${record.lastCommit.slice(0, 12)}`);
    console.log(`    synced:  ${record.lastSyncedAt}`);
    console.log(`    files:   ${record.syncedFiles.length}`);
    console.log();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--list')) {
  listTargets();
  process.exit(0);
}

if (args.includes('--status')) {
  showStatus();
  process.exit(0);
}

if (args.length > 0 && !args[0].startsWith('-')) {
  // Sync a specific target
  const target = getTarget(args[0]);
  if (!target) {
    console.error(`${RED}Unknown target: ${args[0]}${RESET}`);
    console.error(`Available: ${SYNC_TARGETS.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }
  console.log(`${BOLD}Syncing ${target.id}...${RESET}\n`);
  const result = syncTarget(target, MANIFEST);
  printResult(result);
  process.exit(result.error ? 1 : 0);
}

// Sync all enabled targets
const targets = getEnabledTargets();
if (targets.length === 0) {
  console.log(`${DIM}No enabled targets.${RESET}`);
  process.exit(0);
}

console.log(`${BOLD}Syncing ${targets.length} target(s)...${RESET}\n`);
const results = syncAll(targets, MANIFEST);
for (const result of results) {
  printResult(result);
  console.log();
}

const failures = results.filter((r) => r.error);
if (failures.length > 0) {
  console.log(`${RED}${failures.length} target(s) failed.${RESET}`);
  process.exit(1);
}
