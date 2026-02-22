import { eq } from 'drizzle-orm';
import { access } from 'node:fs/promises';
import { db } from '@/lib/db';
import { projects, tasks } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import type { Project } from '@/lib/types';

// --- Types ---

export interface CreateProjectInput {
  name: string;
  description?: string;
  rootPath: string;
  envOverrides?: Record<string, string>;
  color?: string;
  icon?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  rootPath?: string;
  envOverrides?: Record<string, string>;
  color?: string;
  icon?: string;
  isActive?: boolean;
}

// --- Implementation ---

export async function listProjects(isActive?: boolean): Promise<Project[]> {
  const query = db.select().from(projects);
  if (isActive !== undefined) {
    return query.where(eq(projects.isActive, isActive));
  }
  return query;
}

export async function getProject(id: string): Promise<Project> {
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) throw new NotFoundError('Project', id);
  if (!project.isActive) throw new NotFoundError('Project', id);
  return project;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  // Validate rootPath exists on disk before inserting.
  try {
    await access(input.rootPath);
  } catch {
    throw new Error(`rootPath does not exist on disk: ${input.rootPath}`);
  }

  const [project] = await db
    .insert(projects)
    .values({
      name: input.name,
      description: input.description,
      rootPath: input.rootPath,
      envOverrides: input.envOverrides ?? {},
      color: input.color ?? '#6366f1',
      icon: input.icon,
    })
    .returning();

  return project;
}

export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  await getProject(id);

  // If rootPath is changing, validate the new path exists.
  if (input.rootPath) {
    try {
      await access(input.rootPath);
    } catch {
      throw new Error(`rootPath does not exist on disk: ${input.rootPath}`);
    }
  }

  const [updated] = await db
    .update(projects)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id))
    .returning();

  return updated;
}

export async function deleteProject(id: string): Promise<void> {
  // Soft-delete: Tasks retain their projectId. They are hidden from the board via a JOIN filter on
  // projects.is_active. SET NULL FK cascade fires only on hard-delete (purge).
  // Do NOT use getProject() here — it rejects inactive projects, causing 404 on double-delete.
  const [existing] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
  if (!existing) throw new NotFoundError('Project', id);
  await db.update(projects).set({ isActive: false, updatedAt: new Date() }).where(eq(projects.id, id));
}

export async function restoreProject(id: string): Promise<Project> {
  const [existing] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
  if (!existing) throw new NotFoundError('Project', id);
  const [restored] = await db
    .update(projects)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  return restored;
}

export interface PurgeProjectOptions {
  withTasks?: boolean;
}

export async function purgeProject(id: string, options: PurgeProjectOptions = {}): Promise<void> {
  const [existing] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
  if (!existing) throw new NotFoundError('Project', id);
  if (options.withTasks) {
    await db.delete(tasks).where(eq(tasks.projectId, id));
  }
  await db.delete(projects).where(eq(projects.id, id));
}
