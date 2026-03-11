import type { AgentAdapter } from '@/lib/worker/adapters/types';
import { ClaudeSdkAdapter } from '@/lib/worker/adapters/claude-sdk-adapter';
import { CodexAppServerAdapter } from '@/lib/worker/adapters/codex-app-server-adapter';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import type { Agent } from '@/lib/types';
import { getBinaryName } from '@/lib/worker/agent-utils';

/** Maps agent binary basenames to their adapter class. */
const ADAPTER_MAP: Record<string, new () => AgentAdapter> = {
  claude: ClaudeSdkAdapter,
  codex: CodexAppServerAdapter,
  gemini: GeminiAdapter,
};

/**
 * Selects the correct adapter based on agent binary basename.
 */
export function selectAdapter(agent: Agent): AgentAdapter {
  const binaryName = getBinaryName(agent);

  const AdapterClass = ADAPTER_MAP[binaryName];
  if (!AdapterClass) {
    throw new Error(
      `No adapter found for agent binary "${binaryName}". ` +
        `Supported: ${Object.keys(ADAPTER_MAP).join(', ')}`,
    );
  }

  return new AdapterClass();
}
