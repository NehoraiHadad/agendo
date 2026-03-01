'use server';

import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { agentCapabilities } from '@/lib/db/schema';

import { runDiscovery } from '@/lib/discovery';
import type { DiscoveredTool } from '@/lib/discovery';
import { getHelpText, quickParseHelp } from '@/lib/discovery/schema-extractor';
import {
  getExistingSlugs,
  getExistingBinaryPaths,
  createFromDiscovery,
  getAgentById,
} from '@/lib/services/agent-service';
import { getCapabilitiesByAgent } from '@/lib/services/capability-service';
import type { Agent, AgentCapability } from '@/lib/types';

export async function triggerScan(extraTargets?: string[]): Promise<{
  success: boolean;
  data?: DiscoveredTool[];
  error?: string;
}> {
  try {
    const [existingSlugs, existingBinaryPaths] = await Promise.all([
      getExistingSlugs(),
      getExistingBinaryPaths(),
    ]);
    const schemaTargets =
      extraTargets && extraTargets.length > 0 ? new Set(extraTargets) : undefined;
    const tools = await runDiscovery(schemaTargets, existingSlugs, existingBinaryPaths);
    return { success: true, data: tools };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Scan failed',
    };
  }
}

/**
 * Re-extract capabilities from --help for an already-confirmed agent.
 * Adds any new subcommands not already in the DB. Skips duplicates by key.
 */
export async function syncCapabilities(agentId: string): Promise<{
  success: boolean;
  added?: AgentCapability[];
  error?: string;
}> {
  try {
    const agent = await getAgentById(agentId);
    const existing = await getCapabilitiesByAgent(agentId);
    const existingKeys = new Set(existing.map((c) => c.key));

    // Derive binary name for command tokens (e.g. /usr/bin/git → git)
    const binaryName = path.basename(agent.binaryPath);

    const helpText = await getHelpText(agent.binaryPath);
    if (!helpText) {
      return { success: false, error: 'Could not get --help output from this tool.' };
    }

    const schema = quickParseHelp(helpText);
    if (!schema.subcommands.length) {
      return {
        success: false,
        error: 'No subcommands found in --help output. Add commands manually.',
      };
    }

    const newCaps: AgentCapability[] = [];
    for (const subcmd of schema.subcommands) {
      if (existingKeys.has(subcmd.name)) continue;
      const [cap] = await db
        .insert(agentCapabilities)
        .values({
          agentId,
          key: subcmd.name,
          label: subcmd.name,
          description: subcmd.description || null,
          source: 'scan_help',
          interactionMode: 'template',
          commandTokens: [binaryName, subcmd.name],
          dangerLevel: 0,
          isEnabled: true,
        })
        .returning();
      newCaps.push(cap);
    }

    revalidatePath(`/agents/${agentId}`);
    return { success: true, added: newCaps };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Sync failed',
    };
  }
}

export async function confirmTool(tool: DiscoveredTool): Promise<{
  success: boolean;
  data?: Agent;
  error?: string;
}> {
  try {
    const agent = await createFromDiscovery(tool);
    revalidatePath('/agents');
    return { success: true, data: agent };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to confirm tool',
    };
  }
}
