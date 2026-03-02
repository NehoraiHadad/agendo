import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import { agentCapabilities, agents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { ValidationError, TimeoutError } from '@/lib/errors';
import { requireFound } from '@/lib/api-handler';
import type { AgentCapability } from '@/lib/types';

const execFileAsync = promisify(execFile);

interface CreateCapabilityInput {
  agentId: string;
  key: string;
  label: string;
  description?: string | null;
  source?:
    | 'manual'
    | 'builtin'
    | 'preset'
    | 'scan_help'
    | 'scan_completion'
    | 'scan_fig'
    | 'scan_mcp'
    | 'scan_man'
    | 'llm_generated';
  promptTemplate?: string | null;
  requiresApproval?: boolean;
  isEnabled?: boolean;
  dangerLevel?: number;
  timeoutSec?: number;
}

interface UpdateCapabilityInput {
  label?: string;
  description?: string | null;
  promptTemplate?: string | null;
  requiresApproval?: boolean;
  isEnabled?: boolean;
  dangerLevel?: number;
  timeoutSec?: number;
}

export async function createCapability(data: CreateCapabilityInput): Promise<AgentCapability> {
  const [capability] = await db
    .insert(agentCapabilities)
    .values({
      agentId: data.agentId,
      key: data.key,
      label: data.label,
      description: data.description ?? null,
      source: data.source ?? 'manual',
      interactionMode: 'prompt',
      promptTemplate: data.promptTemplate ?? null,
      requiresApproval: data.requiresApproval ?? false,
      isEnabled: data.isEnabled ?? true,
      dangerLevel: data.dangerLevel ?? 0,
      timeoutSec: data.timeoutSec ?? 300,
    })
    .returning();

  return capability;
}

export async function getCapabilitiesByAgent(agentId: string): Promise<AgentCapability[]> {
  return db.select().from(agentCapabilities).where(eq(agentCapabilities.agentId, agentId));
}

export async function getCapabilityById(id: string): Promise<AgentCapability> {
  const [capability] = await db
    .select()
    .from(agentCapabilities)
    .where(eq(agentCapabilities.id, id))
    .limit(1);

  return requireFound(capability, 'Capability', id);
}

export async function updateCapability(
  id: string,
  data: UpdateCapabilityInput,
): Promise<AgentCapability> {
  const [capability] = await db
    .update(agentCapabilities)
    .set(data)
    .where(eq(agentCapabilities.id, id))
    .returning();

  return requireFound(capability, 'Capability', id);
}

export async function deleteCapability(id: string): Promise<void> {
  const [deleted] = await db
    .delete(agentCapabilities)
    .where(eq(agentCapabilities.id, id))
    .returning({ id: agentCapabilities.id });

  requireFound(deleted, 'Capability', id);
}

export async function toggleApproval(id: string): Promise<AgentCapability> {
  const existing = await getCapabilityById(id);

  const [updated] = await db
    .update(agentCapabilities)
    .set({ requiresApproval: !existing.requiresApproval })
    .where(eq(agentCapabilities.id, id))
    .returning();

  return updated;
}

export async function testCapability(id: string): Promise<{ success: boolean; output: string }> {
  const capability = await getCapabilityById(id);

  const [agent] = await db.select().from(agents).where(eq(agents.id, capability.agentId)).limit(1);

  requireFound(agent, 'Agent', capability.agentId);

  try {
    const { stdout } = await execFileAsync(agent.binaryPath, ['--version'], {
      timeout: 5000,
    });
    return { success: true, output: stdout.trim() };
  } catch (err) {
    if (err instanceof Error && 'killed' in err) {
      throw new TimeoutError(`Binary timed out: ${agent.binaryPath}`);
    }
    throw new ValidationError(`Binary test failed: ${agent.binaryPath}`, {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
