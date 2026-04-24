/**
 * Demo-mode shadow for project-service.
 *
 * Exports fixture data and re-implements every public function from
 * project-service.ts without touching the database. Mutations are no-ops
 * that return believable stubs.
 */

import { NotFoundError } from '@/lib/errors';
import type { Project } from '@/lib/types';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  SearchProjectResult,
  PurgeProjectOptions,
} from '@/lib/services/project-service';

// ---------------------------------------------------------------------------
// Canonical demo UUIDs
// ---------------------------------------------------------------------------

export const AGENDO_PROJECT_ID = '44444444-4444-4444-a444-444444444444';
export const OTHER_APP_PROJECT_ID = '55555555-5555-4555-a555-555555555555';
export const PLAYGROUND_PROJECT_ID = '66666666-6666-4666-a666-666666666666';

// ---------------------------------------------------------------------------
// Fixed timestamps — deterministic across renders
// ---------------------------------------------------------------------------

const T_14D_AGO = new Date('2026-04-09T10:00:00.000Z');
const T_10D_AGO = new Date('2026-04-13T10:00:00.000Z');
const T_5D_AGO = new Date('2026-04-18T10:00:00.000Z');
const T_NOW = new Date('2026-04-23T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Fixtures — must satisfy typeof projects.$inferSelect (i.e., Project type)
// ---------------------------------------------------------------------------

export const DEMO_PROJECT_AGENDO: Project = {
  id: AGENDO_PROJECT_ID,
  name: 'agendo',
  description: 'AI coding agent manager.',
  rootPath: '/home/ubuntu/projects/agendo',
  envOverrides: {},
  color: '#10b981',
  icon: '⚙️',
  isActive: true,
  githubRepo: 'nehorai-hadad/agendo',
  githubSyncCursor: null,
  createdAt: T_14D_AGO,
  updatedAt: T_NOW,
};

export const DEMO_PROJECT_OTHER_APP: Project = {
  id: OTHER_APP_PROJECT_ID,
  name: 'my-other-app',
  description: 'Feature planning app (demo target).',
  rootPath: '/home/ubuntu/projects/my-other-app',
  envOverrides: {},
  color: '#6366f1',
  icon: null,
  isActive: true,
  githubRepo: null,
  githubSyncCursor: null,
  createdAt: T_10D_AGO,
  updatedAt: T_10D_AGO,
};

export const DEMO_PROJECT_PLAYGROUND: Project = {
  id: PLAYGROUND_PROJECT_ID,
  name: 'Playground',
  description: 'Scratch project for ad-hoc experiments.',
  rootPath: '/tmp/playground',
  envOverrides: {},
  color: '#f59e0b',
  icon: null,
  isActive: true,
  githubRepo: null,
  githubSyncCursor: null,
  createdAt: T_5D_AGO,
  updatedAt: T_5D_AGO,
};

export const ALL_DEMO_PROJECTS: Project[] = [
  DEMO_PROJECT_AGENDO,
  DEMO_PROJECT_OTHER_APP,
  DEMO_PROJECT_PLAYGROUND,
];

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function listProjects(isActive?: boolean): Promise<Project[]> {
  if (isActive === undefined) {
    return ALL_DEMO_PROJECTS.filter((p) => p.isActive);
  }
  return ALL_DEMO_PROJECTS.filter((p) => p.isActive === isActive);
}

export async function getProject(id: string): Promise<Project> {
  const project = ALL_DEMO_PROJECTS.find((p) => p.id === id);
  if (!project) throw new NotFoundError('Project', id);
  if (!project.isActive) throw new NotFoundError('Project', id);
  return project;
}

export async function searchProjects(q: string, limit = 5): Promise<SearchProjectResult[]> {
  if (!q.trim()) return [];
  const lower = q.toLowerCase();
  const matched = ALL_DEMO_PROJECTS.filter(
    (p) =>
      p.isActive &&
      (p.name.toLowerCase().includes(lower) || p.description?.toLowerCase().includes(lower)),
  );
  return matched.slice(0, limit).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? null,
  }));
}

/**
 * Returns the agendo fixture as the system project in demo mode.
 */
export async function getOrCreateSystemProject(): Promise<Project> {
  return DEMO_PROJECT_AGENDO;
}

// ---------------------------------------------------------------------------
// Mutation stubs — no side effects
// ---------------------------------------------------------------------------

/** Returns a stub project without touching DB. */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  const now = new Date('2026-04-23T10:00:00.000Z');
  return {
    id: 'demo-stub-project-' + Math.random().toString(36).slice(2, 9),
    name: input.name,
    description: input.description ?? null,
    rootPath: input.rootPath,
    envOverrides: input.envOverrides ?? {},
    color: input.color ?? '#6366f1',
    icon: input.icon ?? null,
    isActive: true,
    githubRepo: null,
    githubSyncCursor: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Returns a stub updated project without DB. */
export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  const existing = ALL_DEMO_PROJECTS.find((p) => p.id === id);
  if (!existing) throw new NotFoundError('Project', id);
  return {
    ...existing,
    ...input,
    id,
    updatedAt: new Date('2026-04-23T10:00:00.000Z'),
  };
}

/** No-op soft-delete in demo mode. */
export async function deleteProject(_id: string): Promise<void> {
  // No side effects
}

/** Returns stub restored project in demo mode. */
export async function restoreProject(id: string): Promise<Project> {
  const existing = ALL_DEMO_PROJECTS.find((p) => p.id === id);
  if (!existing) throw new NotFoundError('Project', id);
  return { ...existing, isActive: true, updatedAt: new Date('2026-04-23T10:00:00.000Z') };
}

/** No-op purge in demo mode. */
export async function purgeProject(_id: string, _options?: PurgeProjectOptions): Promise<void> {
  // No side effects
}
