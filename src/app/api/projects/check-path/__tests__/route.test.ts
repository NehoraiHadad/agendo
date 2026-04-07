import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/project-path-service', () => ({
  getProjectPathStatus: vi.fn(),
}));

import { GET } from '../route';
import { getProjectPathStatus } from '@/lib/services/project-path-service';

const mockGetProjectPathStatus = vi.mocked(getProjectPathStatus);

describe('GET /api/projects/check-path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the shared path status payload', async () => {
    mockGetProjectPathStatus.mockResolvedValueOnce({
      status: 'denied',
      normalizedPath: '/etc/secret',
      reason: 'Path not under allowed directories: /workspace',
    });

    const req = new NextRequest('http://localhost/api/projects/check-path?path=/etc/secret');
    const res = await GET(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      status: 'denied',
      normalizedPath: '/etc/secret',
      reason: 'Path not under allowed directories: /workspace',
    });
  });
});
