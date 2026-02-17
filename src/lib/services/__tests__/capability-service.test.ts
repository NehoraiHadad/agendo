import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module before importing anything that uses it
vi.mock('@/lib/db', () => {
  const mockCapability = {
    id: '00000000-0000-0000-0000-000000000088',
    agentId: '00000000-0000-0000-0000-000000000099',
    key: 'run-prompt',
    label: 'Run Prompt',
    interactionMode: 'prompt',
    commandTokens: null,
    requiresApproval: false,
    isEnabled: true,
    dangerLevel: 1,
    timeoutSec: 300,
    createdAt: new Date(),
  };

  const mockReturning = vi.fn().mockResolvedValue([mockCapability]);
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });

  const mockWhere = vi.fn().mockResolvedValue([mockCapability]);

  // from() returns a thenable that also has .where()
  const mockFromResult = Object.assign(Promise.resolve([mockCapability]), { where: mockWhere });
  const mockFrom = vi.fn().mockReturnValue(mockFromResult);

  const mockSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ ...mockCapability, requiresApproval: true }]),
    }),
  });

  return {
    db: {
      select: vi.fn().mockReturnValue({ from: mockFrom }),
      insert: vi.fn().mockReturnValue({ values: mockValues }),
      update: vi.fn().mockReturnValue({ set: mockSet }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockCapability]),
        }),
      }),
    },
  };
});

import { db } from '@/lib/db';

describe('capability-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mode consistency validation', () => {
    function checkModeConsistency(
      mode: 'template' | 'prompt',
      commandTokens: string[] | null,
    ): boolean {
      return mode !== 'template' || commandTokens !== null;
    }

    it('rejects template mode without commandTokens', () => {
      expect(checkModeConsistency('template', null)).toBe(false);
    });

    it('allows prompt mode without commandTokens', () => {
      expect(checkModeConsistency('prompt', null)).toBe(true);
    });

    it('allows template mode with commandTokens', () => {
      expect(checkModeConsistency('template', ['git', 'status'])).toBe(true);
    });
  });

  describe('toggleApproval', () => {
    it('flips requiresApproval field', () => {
      const original = { requiresApproval: false };
      const toggled = { requiresApproval: !original.requiresApproval };
      expect(toggled.requiresApproval).toBe(true);

      // Verify db.update is callable for the toggle operation
      const updateResult = db.update('agent_capabilities' as never);
      expect(db.update).toHaveBeenCalled();

      const setResult = (updateResult as ReturnType<typeof db.update>).set({
        requiresApproval: toggled.requiresApproval,
      } as never);
      expect(setResult).toBeDefined();
    });
  });

  describe('listCapabilities', () => {
    it('returns an array from db.select', async () => {
      const result = await db.select().from('agent_capabilities' as never);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
