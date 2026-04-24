/**
 * Demo-mode shadow for config-service.
 *
 * `getConfigTree` never touches the database (it reads the filesystem directly),
 * so it is NOT wrapped. Only `readConfigFile` and `writeConfigFile` call DB
 * transitively via `assertPathAllowed → fetchProjectRoots`.
 *
 * In demo mode:
 * - `readConfigFile` returns an empty content string (path not validated against DB).
 * - `writeConfigFile` is a no-op (no filesystem writes in demo).
 */

export async function readConfigFile(filePath: string): Promise<{ content: string; path: string }> {
  return { content: '', path: filePath };
}

export async function writeConfigFile(_filePath: string, _content: string): Promise<void> {
  // No-op in demo mode — no filesystem writes.
}

// getConfigTree never touches the DB (reads filesystem directly). We delegate
// to the real implementation to preserve behavior while satisfying the
// demo-coverage meta-test's explicit-export parity rule.
import type { ConfigScope, TreeNode } from './config-service';
import { getConfigTree as realGetConfigTree } from './config-service';

export async function getConfigTree(scope: ConfigScope): Promise<TreeNode[]> {
  return realGetConfigTree(scope);
}
