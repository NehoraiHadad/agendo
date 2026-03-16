import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({
  config: {
    JWT_SECRET: 'test-secret-32-chars-long-enough!',
    WORKER_HTTP_PORT: 4102,
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  sendSessionControl,
  sendSessionEvent,
  sendBrainstormControl,
  sendBrainstormEvent,
} from '../worker-client';

function makeOkResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ dispatched: true }),
  } as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'failed' }),
  } as Response;
}

describe('worker-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendSessionControl', () => {
    it('POSTs to /sessions/:id/control with bearer auth', async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const result = await sendSessionControl('session-abc', { type: 'message', text: 'hi' });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4102/sessions/session-abc/control',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-secret-32-chars-long-enough!',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ type: 'message', text: 'hi' }),
        }),
      );
    });

    it('returns false on non-ok response', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(500));
      const result = await sendSessionControl('session-abc', { type: 'cancel' });
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await sendSessionControl('session-abc', { type: 'cancel' });
      expect(result).toBe(false);
    });
  });

  describe('sendSessionEvent', () => {
    it('POSTs to /sessions/:id/events', async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const result = await sendSessionEvent('session-xyz', { type: 'agent:text', text: 'event' });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4102/sessions/session-xyz/events',
        expect.any(Object),
      );
    });

    it('returns false on failure', async () => {
      mockFetch.mockRejectedValue(new Error('connection refused'));
      const result = await sendSessionEvent('session-xyz', {});
      expect(result).toBe(false);
    });
  });

  describe('sendBrainstormControl', () => {
    it('POSTs to /brainstorms/:id/control', async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const result = await sendBrainstormControl('room-1', { type: 'steer', text: 'pivot' });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4102/brainstorms/room-1/control',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-secret-32-chars-long-enough!',
          }),
          body: JSON.stringify({ type: 'steer', text: 'pivot' }),
        }),
      );
    });

    it('returns false on non-ok response', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(404));
      const result = await sendBrainstormControl('room-1', {});
      expect(result).toBe(false);
    });
  });

  describe('sendBrainstormEvent', () => {
    it('POSTs to /brainstorms/:id/events', async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const result = await sendBrainstormEvent('room-2', { type: 'agent:text', text: 'idea' });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4102/brainstorms/room-2/events',
        expect.any(Object),
      );
    });

    it('returns false on network error', async () => {
      mockFetch.mockRejectedValue(new Error('timeout'));
      const result = await sendBrainstormEvent('room-2', {});
      expect(result).toBe(false);
    });
  });
});
