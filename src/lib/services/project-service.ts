import { eq, and, or, ilike } from 'drizzle-orm';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFilters } from '@/lib/db/filter-builder';
import { db } from '@/lib/db';
import { allowedWorkingDirs } from '@/lib/config';
import { projects, tasks } from '@/lib/db/schema';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { requireFound } from '@/lib/api-handler';
import { detectGitHubRepo } from '@/lib/services/github-service';
import { getProjectPathStatus, validateProjectPath } from '@/lib/services/project-path-service';
import type { Project } from '@/lib/types';
import { isDemoMode } from '@/lib/demo/flag';

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
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.listProjects(isActive);
  }
  const where = buildFilters({ isActive }, { isActive: projects.isActive });
  return db.select().from(projects).where(where);
}

export async function getProject(id: string): Promise<Project> {
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.getProject(id);
  }
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
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.searchProjects(q, limit);
  }
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
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.createProject(input);
  }
  const pathStatus = await getProjectPathStatus(input.rootPath);
  const normalized = await validateProjectPath(input.rootPath);

  if (pathStatus.status === 'creatable') {
    if (!input.createDir) {
      throw new Error(`rootPath does not exist on disk: ${normalized}`);
    }
    await mkdir(normalized, { recursive: true });
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
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.updateProject(id, input);
  }
  await getProject(id);

  // If rootPath is changing, validate the new path exists and re-detect GitHub repo.
  let githubRepo: string | null | undefined;
  let rootPath: string | undefined;
  if (input.rootPath) {
    const status = await getProjectPathStatus(input.rootPath);
    if (status.status !== 'exists') {
      throw new Error(`rootPath does not exist on disk: ${status.normalizedPath}`);
    }
    rootPath = await validateProjectPath(input.rootPath);
    const repoInfo = await detectGitHubRepo(rootPath);
    githubRepo = repoInfo?.fullName ?? null;
  }

  const [updated] = await db
    .update(projects)
    .set({
      ...input,
      ...(rootPath ? { rootPath } : {}),
      ...(githubRepo !== undefined ? { githubRepo } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id))
    .returning();

  return updated;
}

export async function deleteProject(id: string): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.deleteProject(id);
  }
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
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.restoreProject(id);
  }
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
  withDirectory?: boolean;
}

/** Paths that must never be deleted, even if they match ALLOWED_WORKING_DIRS */
const PROTECTED_PATHS = new Set([
  '/',
  '/home',
  '/tmp',
  '/var',
  '/etc',
  '/usr',
  '/root',
  process.env.HOME ?? '/home/ubuntu',
]);

/**
 * Returns the built-in "Agendo System" project (rootPath = cwd).
 * Creates it on first call — idempotent via the rootPath unique constraint.
 */
export async function getOrCreateSystemProject(): Promise<Project> {
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.getOrCreateSystemProject();
  }
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
  if (isDemoMode()) {
    const demo = await import('./project-service.demo');
    return demo.purgeProject(id, options);
  }
  const [existing] = await db
    .select({ id: projects.id, rootPath: projects.rootPath })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  requireFound(existing, 'Project', id);

  // Resolve the directory path before deleting from DB (need rootPath)
  let dirToDelete: string | null = null;
  if (options.withDirectory && existing.rootPath) {
    const normalized = resolve(existing.rootPath);

    // Safety: must be under an allowed working dir
    const isAllowed = allowedWorkingDirs.some(
      (allowed) => normalized.startsWith(allowed + '/') && normalized !== allowed,
    );
    if (!isAllowed) {
      throw new ValidationError(
        `Cannot delete directory outside allowed paths: ${allowedWorkingDirs.join(', ')}`,
      );
    }

    // Safety: must not be a protected system path
    if (PROTECTED_PATHS.has(normalized)) {
      throw new ValidationError(`Cannot delete protected path: ${normalized}`);
    }

    // Safety: must be at least 3 levels deep (e.g. /home/user/project)
    const depth = normalized.split('/').filter(Boolean).length;
    if (depth < 3) {
      throw new ValidationError(`Path too shallow to delete safely: ${normalized}`);
    }

    dirToDelete = normalized;
  }

  // Delete from DB first
  if (options.withTasks) {
    await db.delete(tasks).where(eq(tasks.projectId, id));
  }
  await db.delete(projects).where(eq(projects.id, id));

  // Delete directory from disk after DB cleanup
  if (dirToDelete) {
    await rm(dirToDelete, { recursive: true, force: true });
  }
}
