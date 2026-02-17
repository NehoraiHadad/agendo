import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const mockLimit = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  executions: {
    id: 'id',
    parentExecutionId: 'parentExecutionId',
    status: 'status',
  },
  workerConfig: { key: 'key', value: 'value' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  sql: Object.assign(vi.fn(), {
    raw: vi.fn(),
  }),
}));

const mockGetWorkerConfigNumber = vi.fn();
vi.mock('@/lib/services/worker-config-service', () => ({
  getWorkerConfigNumber: (...args: unknown[]) => mockGetWorkerConfigNumber(...args),
}));

import {
  checkLoopGuards,
  checkTaskCreationRateLimit,
  _resetRateLimits,
} from '@/lib/services/loop-prevention';
import { SafetyViolationError } from '@/lib/errors';

describe('loop-prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimits();
    // Default config values
    mockGetWorkerConfigNumber.mockImplementation((key: string, fallback: number) => {
      const defaults: Record<string, number> = {
        max_spawn_depth: 3,
        max_concurrent_ai_agents: 3,
        max_tasks_per_agent_per_minute: 10,
      };
      return Promise.resolve(defaults[key] ?? fallback);
    });
  });

  describe('checkLoopGuards', () => {
    it('returns spawnDepth 0 when no parentExecutionId', async () => {
      // No parent — only the concurrent check runs
      mockSelect.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ activeCount: 0 }]),
        }),
      }));

      const result = await checkLoopGuards({ agentId: 'agent-1' });
      expect(result.spawnDepth).toBe(0);
    });

    it('walks parent chain correctly (depth 2)', async () => {
      // exec-3 -> exec-2 -> exec-1 (no parent)
      let selectCallIndex = 0;
      mockSelect.mockImplementation(() => {
        selectCallIndex++;
        if (selectCallIndex === 1) {
          // First walk: look up exec-2, it has parent exec-1
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ parentExecutionId: 'exec-1' }]),
              }),
            }),
          };
        }
        if (selectCallIndex === 2) {
          // Second walk: look up exec-1, it has no parent
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ parentExecutionId: null }]),
              }),
            }),
          };
        }
        // Concurrent count check
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ activeCount: 0 }]),
          }),
        };
      });

      const result = await checkLoopGuards({
        parentExecutionId: 'exec-2',
        agentId: 'agent-1',
      });
      expect(result.spawnDepth).toBe(2);
    });

    it('throws SafetyViolationError when depth exceeds max', async () => {
      // Set max_spawn_depth to 2, then create a chain of depth 2
      mockGetWorkerConfigNumber.mockImplementation((key: string) => {
        if (key === 'max_spawn_depth') return Promise.resolve(2);
        if (key === 'max_concurrent_ai_agents') return Promise.resolve(10);
        return Promise.resolve(0);
      });

      let selectCallIndex = 0;
      mockSelect.mockImplementation(() => {
        selectCallIndex++;
        if (selectCallIndex === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ parentExecutionId: 'exec-1' }]),
              }),
            }),
          };
        }
        if (selectCallIndex === 2) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ parentExecutionId: null }]),
              }),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ activeCount: 0 }]),
          }),
        };
      });

      await expect(
        checkLoopGuards({ parentExecutionId: 'exec-2', agentId: 'agent-1' }),
      ).rejects.toThrow(SafetyViolationError);
    });

    it('throws when concurrent limit exceeded', async () => {
      mockGetWorkerConfigNumber.mockImplementation((key: string) => {
        if (key === 'max_concurrent_ai_agents') return Promise.resolve(3);
        return Promise.resolve(10);
      });

      mockSelect.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ activeCount: 3 }]),
        }),
      }));

      await expect(checkLoopGuards({ agentId: 'agent-1' })).rejects.toThrow(SafetyViolationError);
    });
  });

  describe('checkTaskCreationRateLimit', () => {
    it('allows requests under limit', async () => {
      mockGetWorkerConfigNumber.mockResolvedValue(10);
      await expect(checkTaskCreationRateLimit('mcp-agent-1')).resolves.not.toThrow();
    });

    it('throws when limit exceeded', async () => {
      mockGetWorkerConfigNumber.mockResolvedValue(3);

      // Make 3 calls — all should pass
      await checkTaskCreationRateLimit('mcp-agent-2');
      await checkTaskCreationRateLimit('mcp-agent-2');
      await checkTaskCreationRateLimit('mcp-agent-2');

      // 4th call should throw
      await expect(checkTaskCreationRateLimit('mcp-agent-2')).rejects.toThrow(SafetyViolationError);
    });

    it('rate limit resets after window expires', async () => {
      mockGetWorkerConfigNumber.mockResolvedValue(2);

      await checkTaskCreationRateLimit('mcp-agent-3');
      await checkTaskCreationRateLimit('mcp-agent-3');

      // Should be at limit now
      await expect(checkTaskCreationRateLimit('mcp-agent-3')).rejects.toThrow(SafetyViolationError);

      // Reset simulates expired timestamps
      _resetRateLimits();

      // Should work again after reset
      await expect(checkTaskCreationRateLimit('mcp-agent-3')).resolves.not.toThrow();
    });
  });
});
