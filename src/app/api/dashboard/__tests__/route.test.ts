import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockStats = {
  taskCountsByStatus: { todo: 5, in_progress: 3, done: 10 },
  totalTasks: 18,
  recentEvents: [],
  agentHealth: [],
  workerStatus: null,
};

vi.mock('@/lib/services/dashboard-service', () => ({
  getDashboardStats: vi.fn(),
}));

import { GET } from '../route';
import { getDashboardStats } from '@/lib/services/dashboard-service';

const mockGetDashboardStats = vi.mocked(getDashboardStats);

describe('GET /api/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dashboard stats', async () => {
    mockGetDashboardStats.mockResolvedValueOnce(mockStats);

    const req = new NextRequest('http://localhost/api/dashboard');
    const res = await GET(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(mockStats);
    expect(mockGetDashboardStats).toHaveBeenCalledOnce();
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
