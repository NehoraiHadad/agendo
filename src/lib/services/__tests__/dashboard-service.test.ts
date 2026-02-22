import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock data ---

const mockTaskCounts = [
  { status: 'todo', count: 5 },
  { status: 'in_progress', count: 3 },
  { status: 'done', count: 10 },
];

const mockActiveExecCounts = [
  { status: 'running', count: 2 },
  { status: 'queued', count: 1 },
];

const mockFailedRow = [{ count: 4 }];

const mockRecentEvents = [
  {
    id: 1,
    taskId: '00000000-0000-0000-0000-000000000001',
    eventType: 'status_changed',
    actorType: 'user',
    payload: {},
    createdAt: new Date('2026-02-17T10:00:00Z'),
  },
  {
    id: 2,
    taskId: '00000000-0000-0000-0000-000000000002',
    eventType: 'execution_created',
    actorType: 'system',
    payload: { executionId: 'exec-1' },
    createdAt: new Date('2026-02-17T09:00:00Z'),
  },
];

const mockAgentRows = [
  {
    id: 'agent-1',
    name: 'Claude',
    slug: 'claude',
    isActive: true,
    maxConcurrent: 2,
    runningExecutions: 1,
  },
  {
    id: 'agent-2',
    name: 'Codex',
    slug: 'codex',
    isActive: false,
    maxConcurrent: 1,
    runningExecutions: 0,
  },
];

const recentWorkerHeartbeat = {
  workerId: 'worker-1',
  lastSeenAt: new Date(Date.now() - 30 * 1000), // 30s ago = online
  currentExecutions: 2,
  metadata: {},
};

const staleWorkerHeartbeat = {
  workerId: 'worker-1',
  lastSeenAt: new Date(Date.now() - 5 * 60 * 1000), // 5min ago = offline
  currentExecutions: 0,
  metadata: {},
};

const mockActiveExecsList = [
  {
    id: 'exec-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    agentName: 'Claude',
    status: 'running',
    startedAt: new Date('2026-02-17T10:00:00Z'),
    createdAt: new Date('2026-02-17T09:55:00Z'),
  },
];

// --- Query chain builders ---
// Each builder creates a mock chain that resolves at the correct terminal method.

/** select → from → groupBy (resolves) */
function groupByChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      groupBy: vi.fn().mockResolvedValue(result),
    }),
  };
}

/** select → from → where → groupBy (resolves) */
function whereGroupByChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        groupBy: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

/** select → from → where (resolves to array) */
function whereTerminalChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(result),
    }),
  };
}

/** select → from → orderBy → limit (resolves) */
function orderByLimitChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

/** select → from → where → orderBy (resolves) */
function whereOrderByChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

/** select → from → innerJoin → where → orderBy (resolves) */
function joinWhereOrderByChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(result),
        }),
      }),
    }),
  };
}

// Track select calls
let selectCallIndex = 0;
type ChainFactory = () => Record<string, ReturnType<typeof vi.fn>>;
let selectFactories: ChainFactory[] = [];

function resetSelectMock(factories: ChainFactory[]) {
  selectCallIndex = 0;
  selectFactories = factories;
}

const mockSelect = vi.fn(() => {
  const idx = selectCallIndex++;
  const factory = selectFactories[idx];
  if (!factory) throw new Error(`No mock configured for select call #${idx}`);
  return factory();
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => mockSelect(),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  tasks: { status: 'status' },
  executions: {
    id: 'id',
    taskId: 'taskId',
    agentId: 'agentId',
    status: 'status',
    startedAt: 'startedAt',
    endedAt: 'endedAt',
    createdAt: 'createdAt',
  },
  taskEvents: {
    id: 'id',
    taskId: 'taskId',
    eventType: 'eventType',
    actorType: 'actorType',
    payload: 'payload',
    createdAt: 'createdAt',
  },
  agents: {
    id: 'id',
    name: 'name',
    slug: 'slug',
    isActive: 'isActive',
    maxConcurrent: 'maxConcurrent',
  },
  workerHeartbeats: {
    workerId: 'workerId',
    lastSeenAt: 'lastSeenAt',
    currentExecutions: 'currentExecutions',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
  count: vi.fn(() => 'count'),
  gte: vi.fn(),
  inArray: vi.fn(),
}));

import { getDashboardStats, getActiveExecutionsList } from '@/lib/services/dashboard-service';

describe('dashboard-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallIndex = 0;
  });

  /** Standard 6-query getDashboardStats mock setup */
  function setupStatsQueries(overrides?: {
    taskCounts?: unknown;
    activeExecCounts?: unknown;
    failedRow?: unknown;
    recentEvents?: unknown;
    agentRows?: unknown;
    workerRow?: unknown;
  }) {
    resetSelectMock([
      () => groupByChain(overrides?.taskCounts ?? mockTaskCounts),
      () => whereGroupByChain(overrides?.activeExecCounts ?? mockActiveExecCounts),
      () => whereTerminalChain(overrides?.failedRow ?? mockFailedRow),
      () => orderByLimitChain(overrides?.recentEvents ?? mockRecentEvents),
      () => whereOrderByChain(overrides?.agentRows ?? mockAgentRows),
      () => orderByLimitChain(overrides?.workerRow ?? [recentWorkerHeartbeat]),
    ]);
  }

  describe('getDashboardStats', () => {
    it('returns correct structure with all fields', async () => {
      setupStatsQueries();

      const stats = await getDashboardStats();

      expect(stats).toEqual({
        taskCountsByStatus: { todo: 5, in_progress: 3, done: 10 },
        totalTasks: 18,
        activeExecutions: 2,
        queuedExecutions: 1,
        failedLast24h: 4,
        recentEvents: mockRecentEvents,
        agentHealth: mockAgentRows,
        workerStatus: {
          isOnline: true,
          currentExecutions: 2,
          lastSeenAt: recentWorkerHeartbeat.lastSeenAt,
        },
      });
    });

    it('groups task counts by status correctly', async () => {
      const customTaskCounts = [
        { status: 'todo', count: 1 },
        { status: 'blocked', count: 2 },
        { status: 'cancelled', count: 3 },
      ];
      setupStatsQueries({
        taskCounts: customTaskCounts,
        activeExecCounts: [],
        failedRow: [{ count: 0 }],
        recentEvents: [],
        agentRows: [],
        workerRow: [],
      });

      const stats = await getDashboardStats();

      expect(stats.taskCountsByStatus).toEqual({ todo: 1, blocked: 2, cancelled: 3 });
      expect(stats.totalTasks).toBe(6);
    });

    it('reports worker online when heartbeat is recent', async () => {
      setupStatsQueries({
        taskCounts: [],
        activeExecCounts: [],
        failedRow: [{ count: 0 }],
        recentEvents: [],
        agentRows: [],
        workerRow: [recentWorkerHeartbeat],
      });

      const stats = await getDashboardStats();

      expect(stats.workerStatus).not.toBeNull();
      expect(stats.workerStatus!.isOnline).toBe(true);
    });

    it('reports worker offline when heartbeat is stale', async () => {
      setupStatsQueries({
        taskCounts: [],
        activeExecCounts: [],
        failedRow: [{ count: 0 }],
        recentEvents: [],
        agentRows: [],
        workerRow: [staleWorkerHeartbeat],
      });

      const stats = await getDashboardStats();

      expect(stats.workerStatus).not.toBeNull();
      expect(stats.workerStatus!.isOnline).toBe(false);
    });

    it('returns null workerStatus when no heartbeats exist', async () => {
      setupStatsQueries({
        taskCounts: [],
        activeExecCounts: [],
        failedRow: [{ count: 0 }],
        recentEvents: [],
        agentRows: [],
        workerRow: [],
      });

      const stats = await getDashboardStats();

      expect(stats.workerStatus).toBeNull();
    });

    it('handles zero active executions', async () => {
      setupStatsQueries({
        taskCounts: [],
        activeExecCounts: [],
        failedRow: [{ count: 0 }],
        recentEvents: [],
        agentRows: [],
        workerRow: [],
      });

      const stats = await getDashboardStats();

      expect(stats.activeExecutions).toBe(0);
      expect(stats.queuedExecutions).toBe(0);
      expect(stats.failedLast24h).toBe(0);
    });

    it('counts cancelling executions as active', async () => {
      setupStatsQueries({
        taskCounts: [],
        activeExecCounts: [{ status: 'cancelling', count: 3 }],
        failedRow: [{ count: 0 }],
        recentEvents: [],
        agentRows: [],
        workerRow: [],
      });

      const stats = await getDashboardStats();

      expect(stats.activeExecutions).toBe(3);
    });
  });

  describe('getActiveExecutionsList', () => {
    it('returns correct structure', async () => {
      resetSelectMock([() => joinWhereOrderByChain(mockActiveExecsList)]);

      const result = await getActiveExecutionsList();

      expect(result).toEqual(mockActiveExecsList);
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('taskId');
      expect(result[0]).toHaveProperty('agentId');
      expect(result[0]).toHaveProperty('agentName');
      expect(result[0]).toHaveProperty('status');
      expect(result[0]).toHaveProperty('startedAt');
      expect(result[0]).toHaveProperty('createdAt');
    });

    it('returns empty array when no active executions', async () => {
      resetSelectMock([() => joinWhereOrderByChain([])]);

      const result = await getActiveExecutionsList();

      expect(result).toEqual([]);
    });
  });
});
