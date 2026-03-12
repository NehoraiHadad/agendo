import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOpts } from './types';

/**
 * Resolve the path to the Claude Code executable.
 * Prefers the system-installed `claude` binary (so user-level skills, hooks, and commands
 * from ~/.claude/ are available). Falls back to the SDK's bundled cli.js if not found.
 *
 * Override with CLAUDE_CLI_PATH env var if needed.
 */
function resolveCliPath(): string {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    // Fallback: use the SDK's bundled cli.js
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    return join(sdkEntry, '..', 'cli.js');
  }
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
    enableFileCheckpointing: opts.enableFileCheckpointing ?? false,
    outputFormat: opts.outputFormat,
    includePartialMessages: true,
    maxBudgetUsd: opts.maxBudgetUsd,
    fallbackModel: opts.fallbackModel,
    systemPrompt: opts.appendSystemPrompt
      ? { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt }
      : undefined,
    canUseTool,
    // Load filesystem settings so user-level skills, hooks, and commands from
    // ~/.claude/ are available. Without this, the SDK runs in isolation mode
    // and no settings are loaded from disk.
    settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
    // SDK hook callbacks (TypeScript in-process hooks, not shell-based .claude/hooks/)
    ...(opts.sdkHooks ? { hooks: opts.sdkHooks } : {}),
    // Programmatically defined subagents
    ...(opts.sdkAgents ? { agents: opts.sdkAgents } : {}),
    // Main thread agent name
    ...(opts.sdkAgent ? { agent: opts.sdkAgent } : {}),
    // Force a specific session UUID (syncs with agendo's session ID)
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
  };
}
