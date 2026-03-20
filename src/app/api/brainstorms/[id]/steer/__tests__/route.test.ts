import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockGetBrainstorm,
  mockSendBrainstormControl,
  mockSendBrainstormEvent,
  mockEnqueueBrainstorm,
  mockIsBrainstormOrchestratorLive,
  mockWriterOpen,
  mockWriterWriteEvent,
  mockWriterClose,
} = vi.hoisted(() => ({
  mockGetBrainstorm: vi.fn(),
  mockSendBrainstormControl: vi.fn(),
  mockSendBrainstormEvent: vi.fn(),
  mockEnqueueBrainstorm: vi.fn(),
  mockIsBrainstormOrchestratorLive: vi.fn(),
  mockWriterOpen: vi.fn(),
  mockWriterWriteEvent: vi.fn(),
  mockWriterClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
}));

vi.mock('@/lib/realtime/worker-client', () => ({
  sendBrainstormControl: mockSendBrainstormControl,
  sendBrainstormEvent: mockSendBrainstormEvent,
}));

vi.mock('@/lib/worker/brainstorm-queue', () => ({
  enqueueBrainstorm: mockEnqueueBrainstorm,
}));

vi.mock('@/lib/brainstorm/orchestrator-liveness', () => ({
  isBrainstormOrchestratorLive: mockIsBrainstormOrchestratorLive,
}));

vi.mock('@/lib/worker/log-writer', () => ({
  FileLogWriter: class {
    open() {
      mockWriterOpen();
    }
    writeEvent(event: unknown) {
      mockWriterWriteEvent(event);
    }
    close() {
      return mockWriterClose();
    }
  },
}));

import { POST } from '../route';

describe('POST /api/brainstorms/[id]/steer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendBrainstormEvent.mockResolvedValue({ ok: true, dispatched: true });
    mockEnqueueBrainstorm.mockResolvedValue('job-1');
  });

  it('persists to log and re-enqueues when a paused room has no live orchestrator', async () => {
    mockGetBrainstorm.mockResolvedValue({
      status: 'paused',
      currentWave: 4,
      logFilePath: '/tmp/brainstorm.log',
    });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Continue with concrete fixes' }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ sent: true, resumed: true });
    expect(mockWriterOpen).toHaveBeenCalled();
    expect(mockWriterWriteEvent).toHaveBeenCalled();
    expect(mockEnqueueBrainstorm).toHaveBeenCalledWith({
      roomId: '11111111-1111-4111-8111-111111111111',
    });
    expect(mockSendBrainstormControl).not.toHaveBeenCalled();
  });

  it('sends control directly when the orchestrator is live', async () => {
    mockGetBrainstorm.mockResolvedValue({
      status: 'paused',
      currentWave: 1,
      logFilePath: '/tmp/brainstorm.log',
    });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(true);

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Push on liveness' }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ sent: true });
    expect(mockSendBrainstormControl).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      type: 'steer',
      text: 'Push on liveness',
    });
    expect(mockWriterWriteEvent).not.toHaveBeenCalled();
    expect(mockEnqueueBrainstorm).not.toHaveBeenCalled();
  });
});
