import { join } from 'node:path';
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOpts } from './types';

/**
 * Resolve the path to the Claude Agent SDK's cli.js.
 * Required because esbuild bundles the SDK into CJS where import.meta.url is undefined.
 */
function resolveCliPath(): string {
  // require.resolve gives us the SDK's entry point; cli.js is a sibling file.
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  return join(sdkEntry, '..', 'cli.js');
}

/**
 * Convert SpawnOpts → SDK Options for use with query() from @anthropic-ai/claude-agent-sdk.
 *
 * Includes: model, effort, permissionMode, allowedTools, mcpServers, sessionId, etc.
 * NOT included: `resume`, `forkSession`, `resumeSessionAt` — these are per-call options
 * spread by ClaudeSdkAdapter._start() depending on spawn vs resume.
 */
export function buildSdkOptions(opts: SpawnOpts, canUseTool: CanUseTool): Options {
  // Strip env vars that block claude from spawning inside itself
  const env = Object.fromEntries(
    Object.entries(opts.env).filter(([k]) => k !== 'CLAUDECODE' && k !== 'CLAUDE_CODE_ENTRYPOINT'),
  );

  // extraArgs keys are without "--" prefix (SDK adds them automatically)
  const extraArgs: Record<string, string | null> = {};
  if (opts.useWorktree) extraArgs['worktree'] = null;
  if (opts.strictMcpConfig) extraArgs['strict-mcp-config'] = null;

  return {
    pathToClaudeCodeExecutable: resolveCliPath(),
    cwd: opts.cwd,
    env,
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode ?? 'default',
    // bypassPermissions requires this explicit safety flag
    allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions',
    allowedTools: opts.allowedTools,
    mcpServers: opts.sdkMcpServers,
    persistSession: !opts.noSessionPersistence,
    includePartialMessages: true,
    maxBudgetUsd: opts.maxBudgetUsd,
    fallbackModel: opts.fallbackModel,
    systemPrompt: opts.appendSystemPrompt
      ? { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt }
      : undefined,
    canUseTool,
    // Force a specific session UUID (syncs with agendo's session ID)
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
  };
}
