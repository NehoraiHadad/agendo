import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock data ---
const PLAN_ID = '00000000-0000-0000-0000-000000000001';
const VERSION_ID = '00000000-0000-0000-0000-000000000010';
const SESSION_ID = '00000000-0000-0000-0000-000000000020';

const mockPlanVersion = {
  id: VERSION_ID,
  planId: PLAN_ID,
  version: 1,
  content: '# My Plan\n\nStep 1: Do something',
  title: 'My Plan',
  createdAt: new Date('2026-03-08T00:00:00Z'),
  metadata: { source: 'exitPlanMode' as const, sessionId: SESSION_ID },
};

const { mockState } = vi.hoisted(() => {
  return {
    mockState: {
      selectResult: [] as unknown[],
      insertResult: [] as unknown[],
      updateResult: [] as unknown[],
    },
  };
});

vi.mock('@/lib/db', () => {
  const createFromResult = () => {
    const whereResult = () =>
      Object.assign(Promise.resolve(mockState.selectResult), {
        limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
        orderBy: vi.fn().mockImplementation(() =>
          Object.assign(Promise.resolve(mockState.selectResult), {
            limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
          }),
        ),
      });

    return Object.assign(Promise.resolve(mockState.selectResult), {
      where: vi.fn().mockImplementation(whereResult),
      orderBy: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(mockState.selectResult), {
          limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
        }),
      ),
      limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
    });
  };

  const mockFrom = vi.fn().mockImplementation(createFromResult);
  const mockReturning = vi.fn().mockImplementation(() => Promise.resolve(mockState.insertResult));
  const mockValues = vi.fn().mockReturnValue({
    returning: mockReturning,
    onConflictDoNothing: vi.fn().mockReturnValue({ returning: mockReturning }),
  });

  const mockUpdateReturning = vi
    .fn()
    .mockImplementation(() => Promise.resolve(mockState.updateResult));
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
  const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });

  return {
    db: {
      select: vi.fn().mockReturnValue({ from: mockFrom }),
      insert: vi.fn().mockReturnValue({ values: mockValues }),
      update: vi.fn().mockReturnValue({ set: mockSet }),
    },
  };
});

// Mock the schema module
vi.mock('@/lib/db/schema', () => ({
  plans: { id: 'plans.id', content: 'plans.content' },
  planVersions: { id: 'pv.id', planId: 'pv.planId', version: 'pv.version', content: 'pv.content' },
}));

import {
  savePlanContent,
  listPlanVersions,
  getPlanVersion,
  comparePlanVersions,
} from '../plan-service';
import { db } from '@/lib/db';

describe('plan-version-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.selectResult = [];
    mockState.insertResult = [mockPlanVersion];
    mockState.updateResult = [];
  });

  describe('savePlanContent', () => {
    it('creates version 1 when no existing versions', async () => {
      mockState.selectResult = [];
      mockState.insertResult = [{ ...mockPlanVersion, version: 1 }];
      mockState.updateResult = [{ id: PLAN_ID }];

      const result = await savePlanContent(PLAN_ID, '# My Plan\n\nStep 1', {
        source: 'exitPlanMode',
        sessionId: SESSION_ID,
      });

      expect(result!.version).toBe(1);
      expect(result!.planId).toBe(PLAN_ID);
      expect(db.insert).toHaveBeenCalled();
      expect(db.update).toHaveBeenCalled();
    });

    it('auto-increments version number', async () => {
      mockState.selectResult = [{ version: 2 }];
      mockState.insertResult = [{ ...mockPlanVersion, version: 3 }];
      mockState.updateResult = [{ id: PLAN_ID }];

      const result = await savePlanContent(PLAN_ID, '# Updated Plan', {
        source: 'manual_edit',
      });

      expect(result!.version).toBe(3);
    });

    it('deduplicates identical consecutive versions', async () => {
      const content = '# Same Plan\n\nNo changes';
      mockState.selectResult = [{ version: 1, content }];

      const result = await savePlanContent(PLAN_ID, content, {
        source: 'exitPlanMode',
      });

      expect(result).toBeNull();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('extracts title from first heading', async () => {
      mockState.selectResult = [];
      mockState.insertResult = [{ ...mockPlanVersion, title: 'Authentication Refactor' }];
      mockState.updateResult = [{ id: PLAN_ID }];

      const result = await savePlanContent(
        PLAN_ID,
        '## Authentication Refactor\n\nRewrite auth flow',
        { source: 'manual_edit' },
      );

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Authentication Refactor');
    });
  });

  describe('listPlanVersions', () => {
    it('returns all versions for a plan (without content)', async () => {
      const versions = [
        { id: 'v1', version: 1, title: 'Draft 1', createdAt: new Date(), metadata: {} },
        { id: 'v2', version: 2, title: 'Draft 2', createdAt: new Date(), metadata: {} },
      ];
      mockState.selectResult = versions;

      const result = await listPlanVersions(PLAN_ID);

      expect(result).toHaveLength(2);
      expect(db.select).toHaveBeenCalled();
    });

    it('returns empty array when no versions exist', async () => {
      mockState.selectResult = [];

      const result = await listPlanVersions(PLAN_ID);

      expect(result).toEqual([]);
    });
  });

  describe('getPlanVersion', () => {
    it('returns full content for a specific version', async () => {
      mockState.selectResult = [mockPlanVersion];

      const result = await getPlanVersion(PLAN_ID, 1);

      expect(result.content).toBe('# My Plan\n\nStep 1: Do something');
      expect(result.version).toBe(1);
    });

    it('throws NotFoundError for non-existent version', async () => {
      mockState.selectResult = [];

      await expect(getPlanVersion(PLAN_ID, 99)).rejects.toThrow();
    });
  });

  describe('comparePlanVersions', () => {
    it('returns content of both versions for client-side diff', async () => {
      const v1 = { ...mockPlanVersion, version: 1, content: 'Version 1 content' };
      const v2 = { ...mockPlanVersion, version: 2, content: 'Version 2 content' };

      let callCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        callCount++;
        const data = callCount <= 1 ? [v1] : [v2];
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(data),
            }),
          }),
        } as unknown as ReturnType<typeof db.select>;
      });

      const result = await comparePlanVersions(PLAN_ID, 1, 2);

      expect(result.v1.content).toBe('Version 1 content');
      expect(result.v2.content).toBe('Version 2 content');
      expect(result.v1.version).toBe(1);
      expect(result.v2.version).toBe(2);
    });
  });
});
