import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('@/lib/config', () => ({
  config: {
    JWT_SECRET: 'test-secret-32-chars-long-enough!',
    WORKER_HTTP_PORT: 0, // 0 = OS picks free port
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

// Use a factory that creates the Map inside the mock — avoids hoisting issues
vi.mock('@/lib/worker/session-runner', () => ({
  allSessionProcs: new Map<string, { onControl: ReturnType<typeof vi.fn> }>(),
}));

import * as http from 'node:http';
import { startWorkerHttp, stopWorkerHttp, liveBrainstormHandlers } from '../worker-http';
import { allSessionProcs } from '@/lib/worker/session-runner';

// Typed for convenience (cast through unknown to avoid type-overlap check)
const sessionProcs = allSessionProcs as unknown as Map<
  string,
  { onControl: ReturnType<typeof vi.fn> }
>;

// Helper to make a request to the test server
async function request(
  server: http.Server,
  method: string,
  path: string,
  opts: { auth?: boolean; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const addr = server.address() as { port: number };
  const port = addr.port;

  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (opts.auth !== false) {
      headers['Authorization'] = 'Bearer test-secret-32-chars-long-enough!';
    }
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const req = http.request({ hostname: 'localhost', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          resolve({ status: res.statusCode ?? 0, body: parsed });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: {} });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('worker-http', () => {
  let server: http.Server;

  beforeEach(async () => {
    sessionProcs.clear();
    liveBrainstormHandlers.clear();
    server = startWorkerHttp();
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
      } else {
        server.once('listening', () => resolve());
      }
    });
  });

  afterEach(async () => {
    await stopWorkerHttp();
  });

  describe('GET /health', () => {
    it('returns status ok and session count without auth', async () => {
      const { status, body } = await request(server, 'GET', '/health', { auth: false });
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.sessions).toBe(0);
    });

    it('reflects active session count', async () => {
      sessionProcs.set('session-1', { onControl: vi.fn() });
      const { status, body } = await request(server, 'GET', '/health', { auth: false });
      expect(status).toBe(200);
      expect(body.sessions).toBe(1);
    });
  });

  describe('auth', () => {
    it('returns 401 with no auth header on protected routes', async () => {
      const { status } = await request(server, 'POST', '/sessions/abc/control', {
        auth: false,
        body: {},
      });
      expect(status).toBe(401);
    });

    it('returns 401 with wrong bearer token', async () => {
      const addr = server.address() as { port: number };
      const port = addr.port;
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        const body = '{}';
        const req = http.request(
          {
            hostname: 'localhost',
            port,
            path: '/sessions/abc/control',
            method: 'POST',
            headers: {
              Authorization: 'Bearer wrong-token',
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body).toString(),
            },
          },
          (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0 });
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      expect(result.status).toBe(401);
    });
  });

  describe('POST /sessions/:id/control', () => {
    it('dispatches to live session proc', async () => {
      const mockOnControl = vi.fn().mockResolvedValue(undefined);
      sessionProcs.set('session-abc', { onControl: mockOnControl });

      const payload = { type: 'message', text: 'hello' };
      const { status, body } = await request(server, 'POST', '/sessions/session-abc/control', {
        body: payload,
      });

      expect(status).toBe(200);
      expect(body.dispatched).toBe(true);
      expect(mockOnControl).toHaveBeenCalledWith(JSON.stringify(payload));
    });

    it('returns dispatched=false when session not found', async () => {
      const { status, body } = await request(server, 'POST', '/sessions/unknown-id/control', {
        body: { type: 'cancel' },
      });
      expect(status).toBe(200);
      expect(body.dispatched).toBe(false);
    });
  });

  describe('POST /sessions/:id/events', () => {
    it('routes synthetic events to session proc onControl', async () => {
      const mockOnControl = vi.fn().mockResolvedValue(undefined);
      sessionProcs.set('session-xyz', { onControl: mockOnControl });

      const payload = { type: 'agent:text', text: 'injected' };
      const { status, body } = await request(server, 'POST', '/sessions/session-xyz/events', {
        body: payload,
      });

      expect(status).toBe(200);
      expect(body.dispatched).toBe(true);
      expect(mockOnControl).toHaveBeenCalledWith(JSON.stringify(payload));
    });
  });

  describe('POST /brainstorms/:id/control', () => {
    it('dispatches to live brainstorm handler', async () => {
      const handler = vi.fn();
      liveBrainstormHandlers.set('room-1', handler);

      const payload = { type: 'steer', text: 'go left' };
      const { status, body } = await request(server, 'POST', '/brainstorms/room-1/control', {
        body: payload,
      });

      expect(status).toBe(200);
      expect(body.dispatched).toBe(true);
      expect(handler).toHaveBeenCalledWith(JSON.stringify(payload));
    });

    it('returns dispatched=false when brainstorm not found', async () => {
      const { status, body } = await request(server, 'POST', '/brainstorms/unknown/control', {
        body: { type: 'end' },
      });
      expect(status).toBe(200);
      expect(body.dispatched).toBe(false);
    });
  });

  describe('POST /brainstorms/:id/events', () => {
    it('dispatches synthetic events to brainstorm handler', async () => {
      const handler = vi.fn();
      liveBrainstormHandlers.set('room-2', handler);

      const payload = { type: 'agent:text', text: 'brainstorm event' };
      const { status, body } = await request(server, 'POST', '/brainstorms/room-2/events', {
        body: payload,
      });

      expect(status).toBe(200);
      expect(body.dispatched).toBe(true);
      expect(handler).toHaveBeenCalledWith(JSON.stringify(payload));
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unrecognized paths with auth', async () => {
      const { status } = await request(server, 'POST', '/unknown/path/here', { body: {} });
      expect(status).toBe(404);
    });

    it('returns 401 for unrecognized paths without auth', async () => {
      const { status } = await request(server, 'POST', '/unknown/path/here', {
        auth: false,
        body: {},
      });
      expect(status).toBe(401);
    });
  });
});
