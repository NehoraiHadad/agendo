import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockGetBrainstorm,
  mockExtendBrainstorm,
  mockUpdateBrainstormMaxWaves,
  mockEnqueueBrainstorm,
  mockSendBrainstormControl,
  mockIsBrainstormOrchestratorLive,
} = vi.hoisted(() => ({
  mockGetBrainstorm: vi.fn(),
  mockExtendBrainstorm: vi.fn(),
  mockUpdateBrainstormMaxWaves: vi.fn(),
  mockEnqueueBrainstorm: vi.fn(),
  mockSendBrainstormControl: vi.fn(),
  mockIsBrainstormOrchestratorLive: vi.fn(),
}));

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
  extendBrainstorm: mockExtendBrainstorm,
  updateBrainstormMaxWaves: mockUpdateBrainstormMaxWaves,
}));

vi.mock('@/lib/worker/brainstorm-queue', () => ({
  enqueueBrainstorm: mockEnqueueBrainstorm,
}));

vi.mock('@/lib/realtime/worker-client', () => ({
  sendBrainstormControl: mockSendBrainstormControl,
}));

vi.mock('@/lib/brainstorm/orchestrator-liveness', () => ({
  isBrainstormOrchestratorLive: mockIsBrainstormOrchestratorLive,
}));

import { POST } from '../route';

describe('POST /api/brainstorms/[id]/extend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses live control flow for paused rooms with a live orchestrator', async () => {
    mockGetBrainstorm.mockResolvedValue({ status: 'paused', maxWaves: 10 });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(true);
    mockUpdateBrainstormMaxWaves.mockResolvedValue({ id: 'room-1', maxWaves: 15 });

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/extend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ additionalWaves: 5 }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.maxWaves).toBe(15);
    expect(mockSendBrainstormControl).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      type: 'extend',
      additionalWaves: 5,
    });
    expect(mockUpdateBrainstormMaxWaves).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      15,
    );
    expect(mockExtendBrainstorm).not.toHaveBeenCalled();
    expect(mockEnqueueBrainstorm).not.toHaveBeenCalled();
  });

  it('re-enqueues paused rooms whose orchestrator is dead', async () => {
    mockGetBrainstorm.mockResolvedValue({ status: 'paused', maxWaves: 10 });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(false);
    mockExtendBrainstorm.mockResolvedValue({ id: 'room-1', status: 'waiting', maxWaves: 15 });

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/extend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ additionalWaves: 5 }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status).toBe('waiting');
    expect(mockExtendBrainstorm).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 5);
    expect(mockEnqueueBrainstorm).toHaveBeenCalledWith({
      roomId: '11111111-1111-4111-8111-111111111111',
    });
    expect(mockSendBrainstormControl).not.toHaveBeenCalled();
    expect(mockUpdateBrainstormMaxWaves).not.toHaveBeenCalled();
  });
});
