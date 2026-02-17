import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockStats = {
  taskCountsByStatus: { todo: 5, in_progress: 3, done: 10 },
  totalTasks: 18,
  activeExecutions: 2,
  queuedExecutions: 1,
  failedLast24h: 4,
  recentEvents: [],
  agentHealth: [],
  workerStatus: null,
};

const mockActiveExecs = [
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

vi.mock('@/lib/services/dashboard-service', () => ({
  getDashboardStats: vi.fn(),
  getActiveExecutionsList: vi.fn(),
}));

import { GET } from '../route';
import { getDashboardStats, getActiveExecutionsList } from '@/lib/services/dashboard-service';

const mockGetDashboardStats = vi.mocked(getDashboardStats);
const mockGetActiveExecs = vi.mocked(getActiveExecutionsList);

describe('GET /api/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dashboard stats by default', async () => {
    mockGetDashboardStats.mockResolvedValueOnce(mockStats);

    const req = new NextRequest('http://localhost/api/dashboard');
    const res = await GET(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(mockStats);
    expect(mockGetDashboardStats).toHaveBeenCalledOnce();
    expect(mockGetActiveExecs).not.toHaveBeenCalled();
  });

  it('returns active executions when view=active-executions', async () => {
    mockGetActiveExecs.mockResolvedValueOnce(mockActiveExecs);

    const req = new NextRequest('http://localhost/api/dashboard?view=active-executions');
    const res = await GET(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(
      mockActiveExecs.map((e) => ({
        ...e,
        startedAt: e.startedAt.toISOString(),
        createdAt: e.createdAt.toISOString(),
      })),
    );
    expect(mockGetActiveExecs).toHaveBeenCalledOnce();
    expect(mockGetDashboardStats).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    mockGetDashboardStats.mockRejectedValueOnce(new Error('DB down'));

    const req = new NextRequest('http://localhost/api/dashboard');
    const res = await GET(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
