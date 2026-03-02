import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock data ---

const mockTaskCounts = [
  { status: 'todo', count: 5 },
  { status: 'in_progress', count: 3 },
  { status: 'done', count: 10 },
];

const mockRecentEvents = [
  {
    id: 1,
    taskId: '00000000-0000-0000-0000-000000000001',
    eventType: 'status_changed',
    actorType: 'user',
    payload: {},
    createdAt: new Date('2026-02-17T10:00:00Z'),
  },
];

const mockAgentRows = [
  { id: 'agent-1', name: 'Claude', slug: 'claude', isActive: true, maxConcurrent: 2 },
  { id: 'agent-2', name: 'Codex', slug: 'codex', isActive: false, maxConcurrent: 1 },
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

// --- Query chain builders ---

/** select → from → groupBy (resolves) */
function groupByChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      groupBy: vi.fn().mockResolvedValue(result),
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
    toolType: 'toolType',
  },
  workerHeartbeats: {
    workerId: 'workerId',
    lastSeenAt: 'lastSeenAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(() => 'count'),
}));

import { getDashboardStats } from '@/lib/services/dashboard-service';

describe('dashboard-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallIndex = 0;
  });

  /** Standard 4-query getDashboardStats mock setup */
  function setupStatsQueries(overrides?: {
    taskCounts?: unknown;
    recentEvents?: unknown;
    agentRows?: unknown;
    workerRow?: unknown;
  }) {
    resetSelectMock([
      () => groupByChain(overrides?.taskCounts ?? mockTaskCounts),
      () => orderByLimitChain(overrides?.recentEvents ?? mockRecentEvents),
      () => whereOrderByChain(overrides?.agentRows ?? mockAgentRows),
      () => orderByLimitChain(overrides?.workerRow ?? [recentWorkerHeartbeat]),
    ]);
  }

  describe('getDashboardStats', () => {
    it('returns correct structure with all fields', async () => {
      setupStatsQueries();

      const stats = await getDashboardStats();

      expect(stats).toMatchObject({
        taskCountsByStatus: { todo: 5, in_progress: 3, done: 10 },
        totalTasks: 18,
        recentEvents: mockRecentEvents,
        agentHealth: mockAgentRows,
      });
      expect(stats.workerStatus).not.toBeNull();
      expect(stats.workerStatus!.isOnline).toBe(true);
    });

    it('groups task counts by status correctly', async () => {
      const customTaskCounts = [
        { status: 'todo', count: 1 },
        { status: 'blocked', count: 2 },
        { status: 'cancelled', count: 3 },
      ];
      setupStatsQueries({
        taskCounts: customTaskCounts,
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
        recentEvents: [],
        agentRows: [],
        workerRow: [],
      });

      const stats = await getDashboardStats();

      expect(stats.workerStatus).toBeNull();
    });
  });
});
