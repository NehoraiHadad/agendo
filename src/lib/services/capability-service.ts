import { db } from '@/lib/db';
import { agentCapabilities } from '@/lib/db/schema';
import { eq, and, type SQL } from 'drizzle-orm';
import type { AgentCapability, NewCapability, InteractionMode, SupportStatus } from '@/lib/types';
import { isDemoMode } from '@/lib/demo/flag';

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface CapabilityFilters {
  interactionMode?: InteractionMode;
  supportStatus?: SupportStatus;
  isEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listCapabilities(
  agentId: string,
  filters?: CapabilityFilters,
): Promise<AgentCapability[]> {
  if (isDemoMode()) {
    const demo = await import('./capability-service.demo');
    return demo.listCapabilities(agentId, filters);
  }
  const conditions: SQL[] = [eq(agentCapabilities.agentId, agentId)];

  if (filters?.interactionMode) {
    conditions.push(eq(agentCapabilities.interactionMode, filters.interactionMode));
  }
  if (filters?.supportStatus) {
    conditions.push(eq(agentCapabilities.supportStatus, filters.supportStatus));
  }
  if (filters?.isEnabled !== undefined) {
    conditions.push(eq(agentCapabilities.isEnabled, filters.isEnabled));
  }

  return db
    .select()
    .from(agentCapabilities)
    .where(and(...conditions));
}

export async function getCapability(id: string): Promise<AgentCapability | undefined> {
  if (isDemoMode()) {
    const demo = await import('./capability-service.demo');
    return demo.getCapability(id);
  }
  const rows = await db.select().from(agentCapabilities).where(eq(agentCapabilities.id, id));
  return rows[0];
}

export async function getCapabilityByKey(
  agentId: string,
  key: string,
): Promise<AgentCapability | undefined> {
  if (isDemoMode()) {
    const demo = await import('./capability-service.demo');
    return demo.getCapabilityByKey(agentId, key);
  }
  const rows = await db
    .select()
    .from(agentCapabilities)
    .where(and(eq(agentCapabilities.agentId, agentId), eq(agentCapabilities.key, key)));
  return rows[0];
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createCapability(data: NewCapability): Promise<AgentCapability> {
  if (isDemoMode()) {
    const demo = await import('./capability-service.demo');
    return demo.createCapability(data as Partial<AgentCapability>);
  }
  const [row] = await db.insert(agentCapabilities).values(data).returning();
  return row;
}

export async function updateCapability(
  id: string,
  data: Partial<
    Pick<
      AgentCapability,
      | 'label'
      | 'description'
      | 'isEnabled'
      | 'supportStatus'
      | 'providerNotes'
      | 'lastTestedAt'
      | 'dangerLevel'
      | 'timeoutSec'
      | 'requiresApproval'
      | 'promptTemplate'
      | 'commandTokens'
      | 'argsSchema'
    >
  >,
): Promise<AgentCapability | undefined> {
  if (isDemoMode()) {
    const demo = await import('./capability-service.demo');
    return demo.updateCapability(id, data as Partial<AgentCapability>);
  }
  const rows = await db
    .update(agentCapabilities)
    .set(data)
    .where(eq(agentCapabilities.id, id))
    .returning();
  return rows[0];
}

export async function deleteCapability(id: string): Promise<boolean> {
  if (isDemoMode()) {
    const demo = await import('./capability-service.demo');
    return demo.deleteCapability(id);
  }
  const rows = await db
    .delete(agentCapabilities)
    .where(eq(agentCapabilities.id, id))
    .returning({ id: agentCapabilities.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

export async function bulkSetSupportStatus(
  agentId: string,
  key: string,
  status: SupportStatus,
  notes?: string,
): Promise<AgentCapability | undefined> {
  if (isDemoMode()) {
    const demo = await import('./capability-service.demo');
    return demo.bulkSetSupportStatus(agentId, key, status, notes);
  }
  const rows = await db
    .update(agentCapabilities)
    .set({
      supportStatus: status,
      providerNotes: notes ?? null,
      lastTestedAt: new Date(),
    })
    .where(and(eq(agentCapabilities.agentId, agentId), eq(agentCapabilities.key, key)))
    .returning();
  return rows[0];
}
