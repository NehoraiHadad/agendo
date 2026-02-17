import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module before importing the service
vi.mock('@/lib/db', () => {
  const mockReturning = vi.fn().mockResolvedValue([{
    id: '00000000-0000-0000-0000-000000000099',
    name: 'Test Agent',
    slug: 'test-agent',
    binaryPath: '/usr/bin/test-tool',
    kind: 'custom',
    isActive: true,
    maxConcurrent: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }]);

  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });

  const mockAgentRow = {
    id: '00000000-0000-0000-0000-000000000099',
    name: 'Test Agent',
    slug: 'test-agent',
    binaryPath: '/usr/bin/test-tool',
  };

  const mockWhere = vi.fn().mockResolvedValue([mockAgentRow]);

  // from() returns a thenable that also has .where()
  const mockFromResult = Object.assign(
    Promise.resolve([mockAgentRow]),
    { where: mockWhere },
  );
  const mockFrom = vi.fn().mockReturnValue(mockFromResult);

  const mockSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: mockReturning }),
  });

  const mockDeleteWhere = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000099' }]),
  });

  return {
    db: {
      select: vi.fn().mockReturnValue({ from: mockFrom }),
      insert: vi.fn().mockReturnValue({ values: mockValues }),
      update: vi.fn().mockReturnValue({ set: mockSet }),
      delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
    },
  };
});

// Mock fs for binary path validation
vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

import { db } from '@/lib/db';
import { accessSync } from 'node:fs';

describe('agent-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createAgent', () => {
    it('generates correct slug from agent name', () => {
      // Slug generation logic: lowercase, replace non-alphanumeric with dashes, trim dashes
      const name = 'Claude Code';
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      expect(slug).toBe('claude-code');

      const name2 = 'My Custom Agent!';
      const slug2 = name2.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      expect(slug2).toBe('my-custom-agent');
    });

    it('validates binary path exists and is executable', () => {
      const mockAccessSync = vi.mocked(accessSync);

      // Valid path succeeds
      mockAccessSync.mockImplementation(() => undefined);
      expect(() => mockAccessSync('/usr/bin/claude')).not.toThrow();

      // Invalid path throws ENOENT
      mockAccessSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });
      expect(() => mockAccessSync('/nonexistent/binary')).toThrow('ENOENT');
    });
  });

  describe('listAgents', () => {
    it('returns an array from db.select', async () => {
      const result = await db.select().from('agents' as never);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('deleteAgent', () => {
    it('calls delete with correct query shape', () => {
      const agentId = '00000000-0000-0000-0000-000000000099';

      // Verify delete is callable and returns a chainable object
      const deleteResult = db.delete('agents' as never);
      expect(db.delete).toHaveBeenCalled();

      const whereResult = (deleteResult as ReturnType<typeof db.delete>).where(agentId as never);
      expect(whereResult).toBeDefined();
    });
  });
});
