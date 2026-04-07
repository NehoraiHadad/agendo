import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/project-path-service', () => ({
  browseProjectDirectories: vi.fn(),
}));

vi.mock('@/lib/services/project-service', () => ({
  listProjects: vi.fn(),
}));

import { GET } from '../route';
import { browseProjectDirectories } from '@/lib/services/project-path-service';
import { listProjects } from '@/lib/services/project-service';

const mockBrowseProjectDirectories = vi.mocked(browseProjectDirectories);
const mockListProjects = vi.mocked(listProjects);

describe('GET /api/projects/browse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns browse data with registration flags', async () => {
    mockBrowseProjectDirectories.mockResolvedValueOnce({
      currentPath: '/workspace',
      parentPath: null,
      roots: ['/workspace'],
      entries: [
        {
          path: '/workspace/already-added',
          name: 'already-added',
          type: 'git',
          isProjectLike: true,
        },
        {
          path: '/workspace/new-folder',
          name: 'new-folder',
          type: 'other',
          isProjectLike: false,
        },
      ],
    });
    mockListProjects.mockResolvedValueOnce([
      {
        id: 'proj-1',
        name: 'Existing',
        description: null,
        rootPath: '/workspace/already-added',
        envOverrides: {},
        color: '#6366f1',
        icon: null,
        isActive: true,
        githubRepo: null,
        githubSyncCursor: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const req = new NextRequest('http://localhost/api/projects/browse?path=/workspace');
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.currentPathRegistered).toBe(false);
    expect(body.data.entries).toEqual([
      expect.objectContaining({
        path: '/workspace/already-added',
        isRegistered: true,
      }),
      expect.objectContaining({
        path: '/workspace/new-folder',
        isRegistered: false,
      }),
    ]);
  });

  it('marks the current path as registered when it already exists as a project', async () => {
    mockBrowseProjectDirectories.mockResolvedValueOnce({
      currentPath: '/workspace/already-added',
      parentPath: '/workspace',
      roots: ['/workspace'],
      entries: [],
    });
    mockListProjects.mockResolvedValueOnce([
      {
        id: 'proj-1',
        name: 'Existing',
        description: null,
        rootPath: '/workspace/already-added',
        envOverrides: {},
        color: '#6366f1',
        icon: null,
        isActive: true,
        githubRepo: null,
        githubSyncCursor: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const req = new NextRequest(
      'http://localhost/api/projects/browse?path=/workspace/already-added',
    );
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.currentPathRegistered).toBe(true);
  });
});
