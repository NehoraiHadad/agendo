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

const ROOM_UUID = '11111111-1111-4111-8111-111111111111';

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
      params: Promise.resolve({ id: ROOM_UUID }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ sent: true, resumed: true, steerId: expect.any(String) });
    expect(mockWriterOpen).toHaveBeenCalled();
    expect(mockWriterWriteEvent).toHaveBeenCalled();
    expect(mockEnqueueBrainstorm).toHaveBeenCalledWith({
      roomId: ROOM_UUID,
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
      params: Promise.resolve({ id: ROOM_UUID }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ sent: true, steerId: expect.any(String) });
    expect(mockSendBrainstormControl).toHaveBeenCalledWith(ROOM_UUID, {
      type: 'steer',
      text: 'Push on liveness',
      steerId: expect.any(String),
    });
    expect(mockWriterWriteEvent).not.toHaveBeenCalled();
    expect(mockEnqueueBrainstorm).not.toHaveBeenCalled();
  });

  // --- Single-writer: route must NOT emit SSE events ---

  it('does NOT emit SSE events directly (single-writer: orchestrator emits)', async () => {
    mockGetBrainstorm.mockResolvedValue({
      status: 'paused',
      currentWave: 2,
      logFilePath: '/tmp/brainstorm.log',
    });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(true);

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Focus on performance' }),
    });

    await POST(req, { params: Promise.resolve({ id: ROOM_UUID }) });

    // The route must NOT call sendBrainstormEvent — only the orchestrator emits steer events
    expect(mockSendBrainstormEvent).not.toHaveBeenCalled();
  });

  it('does NOT emit SSE events when resuming a dead orchestrator', async () => {
    mockGetBrainstorm.mockResolvedValue({
      status: 'paused',
      currentWave: 3,
      logFilePath: '/tmp/brainstorm.log',
    });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Resume please' }),
    });

    await POST(req, { params: Promise.resolve({ id: ROOM_UUID }) });

    // No direct SSE emission — orchestrator will emit when it processes the steer from log
    expect(mockSendBrainstormEvent).not.toHaveBeenCalled();
  });

  // --- steerId tracing ---

  it('includes a steerId in the control message for live orchestrator', async () => {
    mockGetBrainstorm.mockResolvedValue({
      status: 'paused',
      currentWave: 1,
      logFilePath: '/tmp/brainstorm.log',
    });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(true);

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Add metrics' }),
    });

    await POST(req, { params: Promise.resolve({ id: ROOM_UUID }) });

    const controlPayload = mockSendBrainstormControl.mock.calls[0][1] as {
      steerId: string;
    };
    expect(controlPayload.steerId).toBeDefined();
    expect(typeof controlPayload.steerId).toBe('string');
    expect(controlPayload.steerId.length).toBeGreaterThan(0);
  });

  it('includes a steerId in the log entry for dead orchestrator', async () => {
    mockGetBrainstorm.mockResolvedValue({
      status: 'paused',
      currentWave: 2,
      logFilePath: '/tmp/brainstorm.log',
    });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Fix the bug' }),
    });

    await POST(req, { params: Promise.resolve({ id: ROOM_UUID }) });

    const logEntry = mockWriterWriteEvent.mock.calls[0][0] as { steerId: string };
    expect(logEntry.steerId).toBeDefined();
    expect(typeof logEntry.steerId).toBe('string');
    expect(logEntry.steerId.length).toBeGreaterThan(0);
  });

  it('returns the steerId in the response body', async () => {
    mockGetBrainstorm.mockResolvedValue({
      status: 'paused',
      currentWave: 1,
      logFilePath: '/tmp/brainstorm.log',
    });
    mockIsBrainstormOrchestratorLive.mockResolvedValue(true);

    const req = new NextRequest('http://localhost/api/brainstorms/room-1/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'test' }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: ROOM_UUID }) });
    const body = await res.json();

    expect(body.data.steerId).toBeDefined();
    expect(typeof body.data.steerId).toBe('string');
  });
});
