import { eq, desc } from 'drizzle-orm';
import { buildFilters } from '@/lib/db/filter-builder';
import { db } from '@/lib/db';
import { agentWorkspaces } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import { getById } from '@/lib/services/db-helpers';
import type { AgentWorkspace, WorkspaceLayout } from '@/lib/types';
import { isDemoMode } from '@/lib/demo/flag';

export interface CreateWorkspaceInput {
  name: string;
  projectId?: string;
  layout?: WorkspaceLayout;
}

export interface UpdateWorkspacePatch {
  name?: string;
  layout?: WorkspaceLayout;
  isActive?: boolean;
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<AgentWorkspace> {
  if (isDemoMode()) {
    const demo = await import('./workspace-service.demo');
    return demo.createWorkspace(input);
  }
  const [workspace] = await db
    .insert(agentWorkspaces)
    .values({
      name: input.name,
      projectId: input.projectId ?? null,
      layout: input.layout ?? { panels: [], gridCols: 2 },
    })
    .returning();
  return workspace;
}

export async function getWorkspace(id: string): Promise<AgentWorkspace> {
  if (isDemoMode()) {
    const demo = await import('./workspace-service.demo');
    return demo.getWorkspace(id);
  }
  return getById(agentWorkspaces, id, 'AgentWorkspace');
}

export async function listWorkspaces(filters?: { projectId?: string }): Promise<AgentWorkspace[]> {
  if (isDemoMode()) {
    const demo = await import('./workspace-service.demo');
    return demo.listWorkspaces(filters);
  }
  const where = buildFilters(
    { projectId: filters?.projectId },
    { projectId: agentWorkspaces.projectId },
  );

  return db.select().from(agentWorkspaces).where(where).orderBy(desc(agentWorkspaces.createdAt));
}

export async function updateWorkspace(
  id: string,
  patch: UpdateWorkspacePatch,
): Promise<AgentWorkspace> {
  if (isDemoMode()) {
    const demo = await import('./workspace-service.demo');
    return demo.updateWorkspace(id, patch);
  }
  const updateValues: Partial<typeof agentWorkspaces.$inferInsert> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (patch.name !== undefined) updateValues.name = patch.name;
  if (patch.layout !== undefined) updateValues.layout = patch.layout;
  if (patch.isActive !== undefined) updateValues.isActive = patch.isActive;

  const [updated] = await db
    .update(agentWorkspaces)
    .set(updateValues)
    .where(eq(agentWorkspaces.id, id))
    .returning();
  return requireFound(updated, 'AgentWorkspace', id);
}

export async function deleteWorkspace(id: string): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./workspace-service.demo');
    return demo.deleteWorkspace(id);
  }
  const [deleted] = await db
    .delete(agentWorkspaces)
    .where(eq(agentWorkspaces.id, id))
    .returning({ id: agentWorkspaces.id });
  requireFound(deleted, 'AgentWorkspace', id);
}
