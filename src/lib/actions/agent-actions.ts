'use server';

import { revalidatePath } from 'next/cache';
import {
  createAgent,
  updateAgent,
  deleteAgent,
} from '@/lib/services/agent-service';
import type { Agent } from '@/lib/types';

interface CreateAgentInput {
  name: string;
  binaryPath: string;
  workingDir?: string | null;
  envAllowlist?: string[];
  maxConcurrent?: number;
}

interface UpdateAgentInput {
  name?: string;
  workingDir?: string | null;
  envAllowlist?: string[];
  maxConcurrent?: number;
  isActive?: boolean;
}

export async function createAgentAction(data: CreateAgentInput): Promise<{
  success: boolean;
  data?: Agent;
  error?: string;
}> {
  try {
    const agent = await createAgent(data);
    revalidatePath('/agents');
    return { success: true, data: agent };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create agent',
    };
  }
}

export async function updateAgentAction(
  id: string,
  data: UpdateAgentInput,
): Promise<{
  success: boolean;
  data?: Agent;
  error?: string;
}> {
  try {
    const agent = await updateAgent(id, data);
    revalidatePath('/agents');
    return { success: true, data: agent };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update agent',
    };
  }
}

export async function deleteAgentAction(id: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await deleteAgent(id);
    revalidatePath('/agents');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete agent',
    };
  }
}
