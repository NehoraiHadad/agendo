/**
 * Assemble SpawnOpts from a session record and runtime context.
 */

import type { Session } from '@/lib/types';
import type { SpawnOpts, ImageContent, AcpMcpServer } from '@/lib/worker/adapters/types';

export function buildSpawnOpts(
  session: Pick<
    Session,
    | 'id'
    | 'idleTimeoutSec'
    | 'permissionMode'
    | 'allowedTools'
    | 'model'
    | 'effort'
    | 'kind'
    | 'useWorktree'
  >,
  spawnCwd: string,
  env: Record<string, string>,
  opts: {
    policyFilePath?: string;
    mcpConfigPath?: string;
    mcpServers?: AcpMcpServer[];
    initialImage?: ImageContent;
    developerInstructions?: string;
  },
): SpawnOpts {
  return {
    cwd: spawnCwd,
    env,
    executionId: session.id,
    timeoutSec: session.idleTimeoutSec,
    maxOutputBytes: 10 * 1024 * 1024,
    persistentSession: true, // keep process alive after result for multi-turn
    permissionMode: session.permissionMode ?? 'default',
    allowedTools: session.allowedTools ?? [],
    ...(opts.mcpConfigPath ? { extraArgs: ['--mcp-config', opts.mcpConfigPath] } : {}),
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
    ...(opts.policyFilePath ? { policyFiles: [opts.policyFilePath] } : {}),
    ...(opts.initialImage ? { initialImage: opts.initialImage } : {}),
    // Sync Claude's session ID with agendo's DB session ID
    sessionId: session.id,
    // Only use our MCP servers when an MCP config is provided
    strictMcpConfig: !!opts.mcpConfigPath,
    // Forward model if set on the session (e.g. from DB or API)
    ...(session.model ? { model: session.model } : {}),
    // Forward effort level if set on the session (Claude: low/medium/high thinking depth)
    ...(session.effort ? { effort: session.effort as 'low' | 'medium' | 'high' } : {}),
    // Skip session JSONL persistence for one-off execution sessions (never resumed)
    ...(session.kind === 'execution' ? { noSessionPersistence: true } : {}),
    // Codex: system-level context injected via developerInstructions (not a user turn)
    ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}),
    // Git worktree isolation (Claude only — other CLIs don't support this)
    ...(session.useWorktree ? { useWorktree: true } : {}),
  };
}
