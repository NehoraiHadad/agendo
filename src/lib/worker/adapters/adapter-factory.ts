import type { AgentAdapter } from '@/lib/worker/adapters/types';
import { ClaudeAdapter } from '@/lib/worker/adapters/claude-adapter';
import { CodexAdapter } from '@/lib/worker/adapters/codex-adapter';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import type { Agent } from '@/lib/types';

/** Maps agent binary basenames to their adapter class. */
const ADAPTER_MAP: Record<string, new () => AgentAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  gemini: GeminiAdapter,
};

/**
 * Selects the correct adapter based on agent binary basename.
 */
export function selectAdapter(agent: Agent): AgentAdapter {
  // Extract binary basename: "/usr/bin/claude" -> "claude"
  const binaryName = agent.binaryPath.split('/').pop()?.toLowerCase() ?? '';

  const AdapterClass = ADAPTER_MAP[binaryName];
  if (!AdapterClass) {
    throw new Error(
      `No adapter found for agent binary "${binaryName}". ` +
        `Supported: ${Object.keys(ADAPTER_MAP).join(', ')}`,
    );
  }

  return new AdapterClass();
}
