import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import { agentCapabilities, agents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationError, TimeoutError } from '@/lib/errors';
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
  interactionMode: 'template' | 'prompt';
  commandTokens?: string[] | null;
  promptTemplate?: string | null;
  argsSchema?: Record<string, unknown>;
  requiresApproval?: boolean;
  isEnabled?: boolean;
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
  requiresApproval?: boolean;
  isEnabled?: boolean;
  dangerLevel?: number;
  timeoutSec?: number;
}

function validateModeConsistency(
  mode: 'template' | 'prompt',
  commandTokens: string[] | null | undefined,
): void {
  if (mode === 'template' && (!commandTokens || commandTokens.length === 0)) {
    throw new ValidationError('Template mode requires non-null commandTokens', {
      field: 'commandTokens',
      interactionMode: mode,
    });
  }
}

export async function createCapability(data: CreateCapabilityInput): Promise<AgentCapability> {
  validateModeConsistency(data.interactionMode, data.commandTokens);

  const [capability] = await db
    .insert(agentCapabilities)
    .values({
      agentId: data.agentId,
      key: data.key,
      label: data.label,
      description: data.description ?? null,
      source: data.source ?? 'manual',
      interactionMode: data.interactionMode,
      commandTokens: data.commandTokens ?? null,
      promptTemplate: data.promptTemplate ?? null,
      argsSchema: data.argsSchema ?? {},
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

  if (!capability) throw new NotFoundError('Capability', id);
  return capability;
}

export async function updateCapability(
  id: string,
  data: UpdateCapabilityInput,
): Promise<AgentCapability> {
  // If updating mode or tokens, validate consistency
  if (data.interactionMode || data.commandTokens !== undefined) {
    const existing = await getCapabilityById(id);
    const mode = data.interactionMode ?? existing.interactionMode;
    const tokens = data.commandTokens !== undefined ? data.commandTokens : existing.commandTokens;
    validateModeConsistency(mode, tokens);
  }

  const [capability] = await db
    .update(agentCapabilities)
    .set(data)
    .where(eq(agentCapabilities.id, id))
    .returning();

  if (!capability) throw new NotFoundError('Capability', id);
  return capability;
}

export async function deleteCapability(id: string): Promise<void> {
  const [deleted] = await db
    .delete(agentCapabilities)
    .where(eq(agentCapabilities.id, id))
    .returning({ id: agentCapabilities.id });

  if (!deleted) throw new NotFoundError('Capability', id);
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

  if (!agent) throw new NotFoundError('Agent', capability.agentId);

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
