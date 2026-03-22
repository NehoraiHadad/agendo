import { eq, and, or, ilike } from 'drizzle-orm';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFilters } from '@/lib/db/filter-builder';
import { db } from '@/lib/db';
import { allowedWorkingDirs } from '@/lib/config';
import { projects, tasks } from '@/lib/db/schema';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { requireFound } from '@/lib/api-handler';
import { detectGitHubRepo } from '@/lib/services/github-service';
import type { Project } from '@/lib/types';

// --- Types ---

export interface CreateProjectInput {
  name: string;
  description?: string;
  rootPath: string;
  envOverrides?: Record<string, string>;
  color?: string;
  icon?: string;
  createDir?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  rootPath?: string;
  envOverrides?: Record<string, string>;
  color?: string;
  icon?: string;
  isActive?: boolean;
  githubRepo?: string | null;
}

// --- Implementation ---

export async function listProjects(isActive?: boolean): Promise<Project[]> {
  const where = buildFilters({ isActive }, { isActive: projects.isActive });
  return db.select().from(projects).where(where);
}

export async function getProject(id: string): Promise<Project> {
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  requireFound(project, 'Project', id);
  if (!project.isActive) throw new NotFoundError('Project', id);
  return project;
}

export interface SearchProjectResult {
  id: string;
  name: string;
  description: string | null;
}

export async function searchProjects(q: string, limit = 5): Promise<SearchProjectResult[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, description: projects.description })
    .from(projects)
    .where(
      and(
        eq(projects.isActive, true),
        or(ilike(projects.name, `%${q}%`), ilike(projects.description, `%${q}%`)),
      ),
    )
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
  }));
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const normalized = resolve(input.rootPath);

  try {
    await access(normalized);
  } catch {
    if (input.createDir) {
      // Verify path is under an allowed directory before creating
      const isAllowed = allowedWorkingDirs.some(
        (allowed) => normalized === allowed || normalized.startsWith(allowed + '/'),
      );
      if (!isAllowed) {
        throw new ValidationError(
          `Cannot create directory outside allowed paths: ${allowedWorkingDirs.join(', ')}`,
        );
      }
      await mkdir(normalized, { recursive: true });
    } else {
      throw new Error(`rootPath does not exist on disk: ${normalized}`);
    }
  }

  // Auto-detect GitHub repo from git remotes
  const repoInfo = await detectGitHubRepo(normalized);

  const [project] = await db
    .insert(projects)
    .values({
      name: input.name,
      description: input.description,
      rootPath: normalized,
      envOverrides: input.envOverrides ?? {},
      color: input.color ?? '#6366f1',
      icon: input.icon,
      githubRepo: repoInfo?.fullName ?? null,
    })
    .returning();

  return project;
}

export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  await getProject(id);

  // If rootPath is changing, validate the new path exists and re-detect GitHub repo.
  let githubRepo: string | null | undefined;
  if (input.rootPath) {
    try {
      await access(input.rootPath);
    } catch {
      throw new Error(`rootPath does not exist on disk: ${input.rootPath}`);
    }
    const repoInfo = await detectGitHubRepo(input.rootPath);
    githubRepo = repoInfo?.fullName ?? null;
  }

  const [updated] = await db
    .update(projects)
    .set({
      ...input,
      ...(githubRepo !== undefined ? { githubRepo } : {}),
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
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  requireFound(existing, 'Project', id);
  await db
    .update(projects)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(projects.id, id));
}

export async function restoreProject(id: string): Promise<Project> {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  requireFound(existing, 'Project', id);
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

/**
 * Returns the built-in "Agendo System" project (rootPath = cwd).
 * Creates it on first call — idempotent via the rootPath unique constraint.
 */
export async function getOrCreateSystemProject(): Promise<Project> {
  const systemRoot = process.cwd();
  await db
    .insert(projects)
    .values({
      name: 'Agendo System',
      description: 'System project for Agendo integrations and automation',
      rootPath: systemRoot,
      color: '#10b981',
      icon: '⚙️',
    })
    .onConflictDoNothing();
  const rows = await db.select().from(projects).where(eq(projects.rootPath, systemRoot)).limit(1);
  if (!rows[0]) throw new Error('Failed to create or find system project');
  return rows[0];
}

export async function purgeProject(id: string, options: PurgeProjectOptions = {}): Promise<void> {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  requireFound(existing, 'Project', id);
  if (options.withTasks) {
    await db.delete(tasks).where(eq(tasks.projectId, id));
  }
  await db.delete(projects).where(eq(projects.id, id));
}
