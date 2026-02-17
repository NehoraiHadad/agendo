import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAgent = {
  id: 'agent-1',
  name: 'Test Agent',
  maxConcurrent: 2,
};

const mockCapability = {
  id: 'cap-1',
  agentId: 'agent-1',
  interactionMode: 'template' as const,
};

const mockTask = {
  id: 'task-1',
  status: 'todo' as const,
};

const mockExecution = {
  id: 'exec-1',
  taskId: 'task-1',
  agentId: 'agent-1',
  capabilityId: 'cap-1',
  status: 'queued' as const,
  mode: 'template' as const,
  args: {},
  requestedBy: '00000000-0000-0000-0000-000000000001',
};

// Complex mock for the db
const mockReturning = vi.fn().mockResolvedValue([mockExecution]);
const mockInsertValues = vi.fn().mockReturnValue({ returning: mockReturning });
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

const mockUpdateReturning = vi.fn().mockResolvedValue([{ ...mockExecution, status: 'cancelling' }]);
const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

// For select queries - different chains for different tables
let selectCallCount = 0;
const mockSelect = vi.fn(() => {
  selectCallCount++;
  // Agent select
  if (selectCallCount === 1) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockAgent]),
        }),
      }),
    };
  }
  // Capability select
  if (selectCallCount === 2) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockCapability]),
        }),
      }),
    };
  }
  // Task select
  if (selectCallCount === 3) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockTask]),
        }),
      }),
    };
  }
  // Count select (concurrency check)
  if (selectCallCount === 4) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ runningCount: 0 }]),
      }),
    };
  }
  // Default
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([mockExecution]),
      }),
    }),
  };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: []) => mockSelect(...args),
    insert: (...args: []) => mockInsert(...args),
    update: (...args: []) => mockUpdate(...args),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  executions: {
    id: 'id',
    taskId: 'taskId',
    agentId: 'agentId',
    capabilityId: 'capabilityId',
    status: 'status',
    createdAt: 'createdAt',
  },
  tasks: { id: 'id', status: 'status' },
  agents: { id: 'id' },
  agentCapabilities: { id: 'id', agentId: 'agentId' },
  taskEvents: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
  count: vi.fn(() => 'count'),
}));

vi.mock('@/lib/state-machines', () => ({
  isValidExecutionTransition: vi.fn(() => true),
}));

import { createExecution, cancelExecution } from '@/lib/services/execution-service';

describe('execution-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;
  });

  describe('createExecution', () => {
    it('creates a queued execution', async () => {
      const result = await createExecution({
        taskId: 'task-1',
        agentId: 'agent-1',
        capabilityId: 'cap-1',
      });
      expect(result).toEqual(mockExecution);
      expect(mockInsert).toHaveBeenCalled();
    });
  });

  describe('cancelExecution', () => {
    it('sets status to cancelling', async () => {
      // Reset selectCallCount for cancel (needs only execution select)
      selectCallCount = 0;
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ ...mockExecution, status: 'running' }]),
          }),
        }),
      });

      const result = await cancelExecution('exec-1');
      expect(result.status).toBe('cancelling');
    });
  });
});
