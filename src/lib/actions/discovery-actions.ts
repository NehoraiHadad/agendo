'use server';

import { revalidatePath } from 'next/cache';
import { runDiscovery } from '@/lib/discovery';
import type { DiscoveredTool } from '@/lib/discovery';
import { getExistingSlugs, createFromDiscovery } from '@/lib/services/agent-service';
import type { Agent } from '@/lib/types';

export async function triggerScan(): Promise<{
  success: boolean;
  data?: DiscoveredTool[];
  error?: string;
}> {
  try {
    const existingSlugs = await getExistingSlugs();
    const tools = await runDiscovery(undefined, existingSlugs);
    return { success: true, data: tools };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Scan failed',
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
