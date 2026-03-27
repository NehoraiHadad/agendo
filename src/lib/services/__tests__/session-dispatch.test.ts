import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mocks are available in vi.mock factories
const { mockSendSessionStart } = vi.hoisted(() => ({
  mockSendSessionStart: vi.fn().mockResolvedValue({ ok: true, dispatched: true }),
}));

vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionStart: mockSendSessionStart,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { dispatchSession, type RunSessionJobData } from '../session-dispatch';

describe('dispatchSession', () => {
  const baseData: RunSessionJobData = {
    sessionId: '00000000-0000-0000-0000-000000000001',
    resumePrompt: 'Hello',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sendSessionStart with sessionId and data', async () => {
    await dispatchSession(baseData);

    expect(mockSendSessionStart).toHaveBeenCalledWith(baseData.sessionId, baseData);
  });

  it('throws when sendSessionStart returns not ok', async () => {
    mockSendSessionStart.mockResolvedValueOnce({ ok: false });

    await expect(dispatchSession(baseData)).rejects.toThrow(
      'Failed to dispatch session 00000000-0000-0000-0000-000000000001 to worker',
    );
  });

  it('propagates errors from sendSessionStart', async () => {
    mockSendSessionStart.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(dispatchSession(baseData)).rejects.toThrow('Connection refused');
  });

  it('passes all job data fields through to sendSessionStart', async () => {
    const fullData: RunSessionJobData = {
      sessionId: '00000000-0000-0000-0000-000000000002',
      resumeRef: 'ref-123',
      resumeSessionAt: 'uuid-456',
      resumePrompt: 'Continue',
      resumeClientId: 'client-789',
      skipResumeContext: true,
    };

    await dispatchSession(fullData);

    expect(mockSendSessionStart).toHaveBeenCalledWith(fullData.sessionId, fullData);
  });
});
