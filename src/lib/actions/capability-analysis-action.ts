'use server';

import path from 'node:path';
import { getAgentById } from '@/lib/services/agent-service';
import { getHelpText } from '@/lib/discovery/schema-extractor';
import { queryAI } from '@/lib/services/ai-query-service';
import {
  buildAnalysisPrompt,
  extractJsonArray,
  type AICapabilitySuggestion,
} from '@/lib/services/analyze-service';

export type { AICapabilitySuggestion };

export async function analyzeCapabilitiesWithAI(agentId: string): Promise<{
  success: boolean;
  suggestions?: AICapabilitySuggestion[];
  error?: string;
}> {
  try {
    // 1. Load the agent being analyzed
    const agent = await getAgentById(agentId);
    const toolName = path.basename(agent.binaryPath);

    // 2. Optionally get --help output (best-effort; AI falls back to its own knowledge)
    const helpText = await getHelpText(agent.binaryPath).catch(() => null);

    // 3. Send to AI via the modular ai-query-service (tries all registered providers)
    const prompt = buildAnalysisPrompt(toolName, helpText);
    const { text } = await queryAI({ prompt, timeoutMs: 120_000 });

    // 4. Parse suggestions from AI response
    const suggestions = extractJsonArray(text);

    return { success: true, suggestions };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'AI analysis failed',
    };
  }
}
