import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  db: {
    update: vi.fn(),
  },
}));

vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionControl: vi.fn(),
}));

vi.mock('@/lib/services/session-dispatch', () => ({
  dispatchSession: vi.fn(),
}));

vi.mock('@/lib/services/session-service', () => ({
  getSession: vi.fn(),
  restartFreshFromSession: vi.fn(),
}));

import { POST } from '../route';
import { db } from '@/lib/db';
import { sendSessionControl } from '@/lib/realtime/worker-client';
import { dispatchSession } from '@/lib/services/session-dispatch';
import { getSession, restartFreshFromSession } from '@/lib/services/session-service';

const mockSendSessionControl = vi.mocked(sendSessionControl);
const mockDispatchSession = vi.mocked(dispatchSession);
const mockGetSession = vi.mocked(getSession);
const mockRestartFreshFromSession = vi.mocked(restartFreshFromSession);

const SESSION_ID = '00000000-0000-0000-0000-000000000001';

function makeRequest(
  body: unknown,
  id = SESSION_ID,
): [NextRequest, { params: Promise<Record<string, string>> }] {
  const req = new NextRequest(`http://localhost/api/sessions/${id}/control`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const context = { params: Promise.resolve({ id }) };
  return [req, context];
}

function mockDbUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  vi.mocked(db.update).mockImplementation(update);
  return { update, set, where };
}

describe('POST /api/sessions/[id]/control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbUpdate();
  });

  it('cold-resumes ExitPlanMode approval when DB status is live but worker process is gone', async () => {
    mockGetSession.mockResolvedValue({
      id: SESSION_ID,
      status: 'active',
      permissionMode: 'plan',
      sessionRef: 'claude-session-ref',
      planFilePath: null,
    } as Awaited<ReturnType<typeof getSession>>);
    mockSendSessionControl.mockResolvedValue({ ok: true, dispatched: false });

    const [req, ctx] = makeRequest({
      type: 'tool-approval',
      approvalId: 'approval-1',
      toolName: 'ExitPlanMode',
      decision: 'allow',
      postApprovalMode: 'acceptEdits',
    });

    const res = await POST(req, ctx);

    expect(res.status).toBe(202);
    expect(mockSendSessionControl).toHaveBeenCalledWith(SESSION_ID, {
      type: 'tool-approval',
      approvalId: 'approval-1',
      toolName: 'ExitPlanMode',
      decision: 'allow',
      postApprovalMode: 'acceptEdits',
    });
    expect(mockDispatchSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      resumeRef: 'claude-session-ref',
      resumePrompt: 'Continue implementing the plan from the previous conversation.',
    });
  });

  it('starts the fresh child session directly when restart-fresh approval loses the live worker', async () => {
    mockGetSession.mockResolvedValue({
      id: SESSION_ID,
      status: 'active',
      permissionMode: 'plan',
      sessionRef: 'claude-session-ref',
      planFilePath: null,
    } as Awaited<ReturnType<typeof getSession>>);
    mockRestartFreshFromSession.mockResolvedValue({ id: 'child-session-id' } as never);
    mockSendSessionControl.mockResolvedValue({ ok: true, dispatched: false });

    const [req, ctx] = makeRequest({
      type: 'tool-approval',
      approvalId: 'approval-2',
      toolName: 'ExitPlanMode',
      decision: 'deny',
      clearContextRestart: true,
      postApprovalMode: 'acceptEdits',
    });

    const res = await POST(req, ctx);

    expect(res.status).toBe(202);
    expect(mockRestartFreshFromSession).toHaveBeenCalledWith(SESSION_ID, null, 'acceptEdits');
    expect(mockDispatchSession).toHaveBeenCalledWith({ sessionId: 'child-session-id' });
  });
});
