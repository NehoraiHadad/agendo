import type { AgentAdapter } from '@/lib/worker/adapters/types';
import { ClaudeAdapter } from '@/lib/worker/adapters/claude-adapter';
import { CodexAdapter } from '@/lib/worker/adapters/codex-adapter';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import { TemplateAdapter } from '@/lib/worker/adapters/template-adapter';
import type { Agent, AgentCapability } from '@/lib/types';

/** Maps agent binary basenames to their prompt-mode adapter class. */
const PROMPT_ADAPTER_MAP: Record<string, new () => AgentAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  gemini: GeminiAdapter,
};

/**
 * Selects the correct adapter based on interaction_mode and agent binary.
 * Template mode always uses TemplateAdapter.
 * Prompt mode selects by agent binary basename.
 */
export function selectAdapter(agent: Agent, capability: AgentCapability): AgentAdapter {
  if (capability.interactionMode === 'template') {
    return new TemplateAdapter();
  }

  // Extract binary basename: "/usr/bin/claude" -> "claude"
  const binaryName = agent.binaryPath.split('/').pop()?.toLowerCase() ?? '';

  const AdapterClass = PROMPT_ADAPTER_MAP[binaryName];
  if (!AdapterClass) {
    throw new Error(
      `No adapter found for agent binary "${binaryName}". ` +
        `Supported: ${Object.keys(PROMPT_ADAPTER_MAP).join(', ')}`,
    );
  }

  return new AdapterClass();
}
