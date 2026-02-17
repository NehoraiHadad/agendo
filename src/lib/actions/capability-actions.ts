'use server';

import { revalidatePath } from 'next/cache';
import {
  createCapability,
  updateCapability,
  deleteCapability,
  toggleApproval,
  testCapability,
} from '@/lib/services/capability-service';
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
    revalidatePath('/agents');
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
    revalidatePath('/agents');
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
    revalidatePath('/agents');
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
    revalidatePath('/agents');
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
