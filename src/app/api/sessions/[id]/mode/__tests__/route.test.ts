import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock DB before importing the route
vi.mock('@/lib/db', () => ({
  db: {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  },
}));

vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionControl: vi.fn(),
}));

import { PATCH } from '../route';
import { db } from '@/lib/db';
import { sendSessionControl } from '@/lib/realtime/worker-client';

const mockSendSessionControl = vi.mocked(sendSessionControl);

const SESSION_ID = '00000000-0000-0000-0000-000000000001';

function makeRequest(
  body: unknown,
  id = SESSION_ID,
): [NextRequest, { params: Promise<Record<string, string>> }] {
  const req = new NextRequest(`http://localhost/api/sessions/${id}/mode`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const context = { params: Promise.resolve({ id }) };
  return [req, context];
}

function mockDbReturning(result: unknown[]) {
  // Re-mock the chained calls each time
  const returning = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  vi.mocked(db.update).mockImplementation(update);
  return { update, set, where, returning };
}

describe('PATCH /api/sessions/[id]/mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validation', () => {
    it('returns 400 for missing mode', async () => {
      const [req, ctx] = makeRequest({});
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('returns 400 for invalid mode value', async () => {
      const [req, ctx] = makeRequest({ mode: 'superAdmin' });
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('returns 404 for invalid UUID', async () => {
      const [req, ctx] = makeRequest({ mode: 'default' }, 'not-a-uuid');
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(404);
    });

    it('returns 404 when session does not exist', async () => {
      mockDbReturning([]);
      const [req, ctx] = makeRequest({ mode: 'default' });
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(404);
    });
  });

  describe('successful mode change', () => {
    it('accepts all valid modes including plan and dontAsk', async () => {
      for (const mode of [
        'default',
        'bypassPermissions',
        'acceptEdits',
        'plan',
        'dontAsk',
      ] as const) {
        mockDbReturning([{ id: SESSION_ID, status: 'idle', permissionMode: mode }]);
        const [req, ctx] = makeRequest({ mode });
        const res = await PATCH(req, ctx);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.permissionMode).toBe(mode);
      }
    });

    it('returns updated session in response body', async () => {
      mockDbReturning([{ id: SESSION_ID, status: 'awaiting_input', permissionMode: 'default' }]);
      const [req, ctx] = makeRequest({ mode: 'default' });
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toMatchObject({ id: SESSION_ID, permissionMode: 'default' });
    });
  });

  describe('Worker HTTP control behavior', () => {
    it('sends set-permission-mode control when session is active', async () => {
      mockDbReturning([{ id: SESSION_ID, status: 'active', permissionMode: 'default' }]);
      const [req, ctx] = makeRequest({ mode: 'default' });
      await PATCH(req, ctx);
      expect(mockSendSessionControl).toHaveBeenCalledOnce();
      expect(mockSendSessionControl).toHaveBeenCalledWith(SESSION_ID, {
        type: 'set-permission-mode',
        mode: 'default',
      });
    });

    it('sends set-permission-mode control when session is awaiting_input', async () => {
      mockDbReturning([
        { id: SESSION_ID, status: 'awaiting_input', permissionMode: 'bypassPermissions' },
      ]);
      const [req, ctx] = makeRequest({ mode: 'bypassPermissions' });
      await PATCH(req, ctx);
      expect(mockSendSessionControl).toHaveBeenCalledOnce();
    });

    it('does NOT send control when session is idle', async () => {
      mockDbReturning([{ id: SESSION_ID, status: 'idle', permissionMode: 'acceptEdits' }]);
      const [req, ctx] = makeRequest({ mode: 'acceptEdits' });
      await PATCH(req, ctx);
      expect(mockSendSessionControl).not.toHaveBeenCalled();
    });

    it('does NOT send control when session is ended', async () => {
      mockDbReturning([{ id: SESSION_ID, status: 'ended', permissionMode: 'default' }]);
      const [req, ctx] = makeRequest({ mode: 'default' });
      await PATCH(req, ctx);
      expect(mockSendSessionControl).not.toHaveBeenCalled();
    });
  });
});
