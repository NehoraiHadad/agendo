import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockGetBrainstorm,
  mockExtendBrainstorm,
  mockUpdateBrainstormMaxWaves,
  mockAddWaveBudget,
  mockUpdateBrainstormStatus,
  mockEnqueueBrainstorm,
  mockSendBrainstormControl,
  mockIsBrainstormOrchestratorLive,
} = vi.hoisted(() => ({
  mockGetBrainstorm: vi.fn(),
  mockExtendBrainstorm: vi.fn(),
  mockUpdateBrainstormMaxWaves: vi.fn(),
  mockAddWaveBudget: vi.fn(),
  mockUpdateBrainstormStatus: vi.fn(),
  mockEnqueueBrainstorm: vi.fn(),
  mockSendBrainstormControl: vi.fn(),
  mockIsBrainstormOrchestratorLive: vi.fn(),
}));

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
  extendBrainstorm: mockExtendBrainstorm,
  updateBrainstormMaxWaves: mockUpdateBrainstormMaxWaves,
  addWaveBudget: mockAddWaveBudget,
  updateBrainstormStatus: mockUpdateBrainstormStatus,
}));

vi.mock('@/lib/services/brainstorm-dispatch', () => ({
  dispatchBrainstorm: mockEnqueueBrainstorm,
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
    mockUpdateBrainstormStatus.mockResolvedValue({ id: 'room-1', status: 'waiting', maxWaves: 15 });

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
    // Uses addWaveBudget + updateBrainstormStatus (not extendBrainstorm)
    // because extendBrainstorm requires status='ended', but the room is 'paused'
    expect(mockAddWaveBudget).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 5);
    expect(mockUpdateBrainstormStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'waiting',
    );
    expect(mockEnqueueBrainstorm).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(mockExtendBrainstorm).not.toHaveBeenCalled();
    expect(mockSendBrainstormControl).not.toHaveBeenCalled();
    expect(mockUpdateBrainstormMaxWaves).not.toHaveBeenCalled();
  });

  it('uses extendBrainstorm for ended rooms', async () => {
    mockGetBrainstorm.mockResolvedValue({ status: 'ended', maxWaves: 10 });
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
    expect(mockEnqueueBrainstorm).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(mockAddWaveBudget).not.toHaveBeenCalled();
    expect(mockSendBrainstormControl).not.toHaveBeenCalled();
  });

  it('returns 409 for active rooms', async () => {
    mockGetBrainstorm.mockResolvedValue({ status: 'active', maxWaves: 10 });

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/extend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ additionalWaves: 5 }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    });

    expect(res.status).toBe(409);
  });
});
