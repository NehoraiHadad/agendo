import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentWorkspaces } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import type { AgentWorkspace, WorkspaceLayout } from '@/lib/types';

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
  const [workspace] = await db
    .select()
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.id, id))
    .limit(1);
  if (!workspace) throw new NotFoundError('AgentWorkspace', id);
  return workspace;
}

export async function listWorkspaces(filters?: { projectId?: string }): Promise<AgentWorkspace[]> {
  const conditions = [];
  if (filters?.projectId) conditions.push(eq(agentWorkspaces.projectId, filters.projectId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return db.select().from(agentWorkspaces).where(where).orderBy(desc(agentWorkspaces.createdAt));
}

export async function updateWorkspace(
  id: string,
  patch: UpdateWorkspacePatch,
): Promise<AgentWorkspace> {
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
  if (!updated) throw new NotFoundError('AgentWorkspace', id);
  return updated;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const [deleted] = await db
    .delete(agentWorkspaces)
    .where(eq(agentWorkspaces.id, id))
    .returning({ id: agentWorkspaces.id });
  if (!deleted) throw new NotFoundError('AgentWorkspace', id);
}
