'use server';

import path from 'node:path';
import { revalidatePath } from 'next/cache';
import {
  createCapability,
  updateCapability,
  deleteCapability,
  toggleApproval,
  testCapability,

} from '@/lib/services/capability-service';
import { getAgentById } from '@/lib/services/agent-service';
import { getHelpText } from '@/lib/discovery/schema-extractor';
import { queryAI } from '@/lib/services/ai-query-service';
import type { AgentCapability } from '@/lib/types';

interface CreateCapabilityInput {
  agentId: string;
  key: string;
  label: string;
  description?: string | null;
  interactionMode: 'template' | 'prompt';
  commandTokens?: string[] | null;
  promptTemplate?: string | null;
  argsSchema?: Record<string, unknown>;
  dangerLevel?: number;
  timeoutSec?: number;
}

interface UpdateCapabilityInput {
  label?: string;
  description?: string | null;
  interactionMode?: 'template' | 'prompt';
  commandTokens?: string[] | null;
  promptTemplate?: string | null;
  argsSchema?: Record<string, unknown>;
  isEnabled?: boolean;
  dangerLevel?: number;
  timeoutSec?: number;
}

export async function createCapabilityAction(data: CreateCapabilityInput): Promise<{
  success: boolean;
  data?: AgentCapability;
  error?: string;
}> {
  try {
    const capability = await createCapability(data);
    revalidatePath('/agents', 'layout');
    return { success: true, data: capability };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create capability',
    };
  }
}

export async function updateCapabilityAction(
  id: string,
  data: UpdateCapabilityInput,
): Promise<{
  success: boolean;
  data?: AgentCapability;
  error?: string;
}> {
  try {
    const capability = await updateCapability(id, data);
    revalidatePath('/agents', 'layout');
    return { success: true, data: capability };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update capability',
    };
  }
}

export async function deleteCapabilityAction(id: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await deleteCapability(id);
    revalidatePath('/agents', 'layout');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete capability',
    };
  }
}

export async function toggleApprovalAction(id: string): Promise<{
  success: boolean;
  data?: AgentCapability;
  error?: string;
}> {
  try {
    const capability = await toggleApproval(id);
    revalidatePath('/agents', 'layout');
    return { success: true, data: capability };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to toggle approval',
    };
  }
}

export async function testCapabilityAction(id: string): Promise<{
  success: boolean;
  data?: { success: boolean; output: string };
  error?: string;
}> {
  try {
    const result = await testCapability(id);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Test failed',
    };
  }
}

// ---------------------------------------------------------------------------
// AI Capability Analysis
// ---------------------------------------------------------------------------

export interface AICapabilitySuggestion {
  key: string;
  label: string;
  description: string;
  commandTokens: string[];
  argsSchema: {
    properties?: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  dangerLevel: 0 | 1 | 2 | 3;
}

function buildAnalysisPrompt(toolName: string, helpText: string | null): string {
  const helpSection = helpText
    ? `\nHere is the tool's --help output for reference:\n---\n${helpText.slice(0, 3000)}\n---\n`
    : '';
  return `Suggest the 5 most useful everyday CLI capabilities for the "${toolName}" tool in a developer task management system.${helpSection}
Return ONLY a valid JSON array — no markdown fences, no explanation, no other text.
Each item must have this exact shape:

[
  {
    "key": "commit",
    "label": "Commit",
    "description": "Record staged changes with a message",
    "commandTokens": ["${toolName}", "commit", "-m", "{{message}}"],
    "argsSchema": {
      "properties": {
        "message": { "type": "string", "description": "Commit message" }
      },
      "required": ["message"]
    },
    "dangerLevel": 1
  }
]

Rules:
- Use {{argName}} as a whole token when a value must be supplied by the user
- dangerLevel: 0 = read-only, 1 = modifies local state, 2 = affects remote/shared, 3 = destructive/irreversible
- argsSchema.properties keys must exactly match the {{placeholders}} used in commandTokens
- Commands with no user-provided args use argsSchema: {}
- Return ONLY the JSON array`;
}

function extractJsonArray(raw: string): AICapabilitySuggestion[] {
  // Try to parse the claude --output-format json wrapper first
  try {
    const wrapper = JSON.parse(raw) as { result?: string };
    if (wrapper.result) {
      return extractJsonArray(wrapper.result);
    }
  } catch { /* not a JSON wrapper */ }

  // Strip markdown code fences
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();

  // Try direct parse
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed as AICapabilitySuggestion[];
  } catch { /* fall through */ }

  // Extract first [...] block
  const match = stripped.match(/\[[\s\S]*\]/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed as AICapabilitySuggestion[];
  }

  throw new Error('No JSON array found in AI response');
}

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
