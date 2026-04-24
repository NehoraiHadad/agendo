import { describe, it, expect } from 'vitest';
import {
  syncInbound,
  syncTaskStatusToGitHub,
  syncProgressNoteToGitHub,
  createGitHubIssueForTask,
  runGitHubSync,
  getGitHubSyncStatus,
} from '../github-sync-service.demo';
import type { Project } from '@/lib/types';

// Minimal stub project fixture
const DEMO_PROJECT: Project = {
  id: '44444444-4444-4444-a444-444444444444',
  name: 'agendo',
  description: 'AI coding agent manager.',
  rootPath: '/home/ubuntu/projects/agendo',
  envOverrides: {},
  color: '#10b981',
  icon: null,
  isActive: true,
  githubRepo: 'nehorai-hadad/agendo',
  githubSyncCursor: null,
  createdAt: new Date('2026-04-16T10:00:00.000Z'),
  updatedAt: new Date('2026-04-16T10:00:00.000Z'),
};

describe('github-sync-service.demo', () => {
  describe('syncInbound', () => {
    it('returns a SyncResult with zero counts and no errors', async () => {
      const result = await syncInbound({} as never, DEMO_PROJECT);
      expect(result.projectId).toBe(DEMO_PROJECT.id);
      expect(result.repo).toBe('nehorai-hadad/agendo');
      expect(result.tasksCreated).toBe(0);
      expect(result.tasksUpdated).toBe(0);
      expect(result.commentsSynced).toBe(0);
      expect(result.errors).toEqual([]);
    });
  });

  describe('syncTaskStatusToGitHub', () => {
    it('does not throw', async () => {
      await expect(
        syncTaskStatusToGitHub({} as never, 'todo', 'in_progress'),
      ).resolves.toBeUndefined();
    });
  });

  describe('syncProgressNoteToGitHub', () => {
    it('does not throw', async () => {
      await expect(
        syncProgressNoteToGitHub('11111111-1111-4111-a111-111111111111', 'Made progress'),
      ).resolves.toBeUndefined();
    });
  });

  describe('createGitHubIssueForTask', () => {
    it('returns null', async () => {
      const result = await createGitHubIssueForTask('11111111-1111-4111-a111-111111111111');
      expect(result).toBeNull();
    });
  });

  describe('runGitHubSync', () => {
    it('returns an empty array', async () => {
      const result = await runGitHubSync();
      expect(result).toEqual([]);
    });
  });

  describe('getGitHubSyncStatus', () => {
    it('returns connected=false with null repo and cursor', async () => {
      const result = await getGitHubSyncStatus('44444444-4444-4444-a444-444444444444');
      expect(result).toEqual({ connected: false, repo: null, lastSyncAt: null });
    });
  });
});
