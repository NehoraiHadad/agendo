import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mocks are available in vi.mock factories
const { mockConfig, mockEnqueueSession, mockSendSessionStart } = vi.hoisted(() => ({
  mockConfig: { DIRECT_DISPATCH: false },
  mockEnqueueSession: vi.fn().mockResolvedValue('job-id'),
  mockSendSessionStart: vi.fn().mockResolvedValue({ ok: true, dispatched: true }),
}));

vi.mock('@/lib/config', () => ({
  config: mockConfig,
}));

vi.mock('@/lib/worker/queue', () => ({
  enqueueSession: mockEnqueueSession,
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

import { dispatchSession } from '../session-dispatch';
import type { RunSessionJobData } from '@/lib/worker/queue';

describe('dispatchSession', () => {
  const baseData: RunSessionJobData = {
    sessionId: '00000000-0000-0000-0000-000000000001',
    resumePrompt: 'Hello',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.DIRECT_DISPATCH = false;
  });

  it('calls enqueueSession when DIRECT_DISPATCH is false', async () => {
    mockConfig.DIRECT_DISPATCH = false;

    await dispatchSession(baseData);

    expect(mockEnqueueSession).toHaveBeenCalledWith(baseData);
    expect(mockSendSessionStart).not.toHaveBeenCalled();
  });

  it('calls sendSessionStart when DIRECT_DISPATCH is true', async () => {
    mockConfig.DIRECT_DISPATCH = true;

    await dispatchSession(baseData);

    expect(mockSendSessionStart).toHaveBeenCalledWith(baseData.sessionId, baseData);
    expect(mockEnqueueSession).not.toHaveBeenCalled();
  });

  it('falls back to enqueueSession when sendSessionStart fails', async () => {
    mockConfig.DIRECT_DISPATCH = true;
    mockSendSessionStart.mockResolvedValueOnce({ ok: false });

    await dispatchSession(baseData);

    expect(mockSendSessionStart).toHaveBeenCalledWith(baseData.sessionId, baseData);
    expect(mockEnqueueSession).toHaveBeenCalledWith(baseData);
  });

  it('falls back to enqueueSession when sendSessionStart throws', async () => {
    mockConfig.DIRECT_DISPATCH = true;
    mockSendSessionStart.mockRejectedValueOnce(new Error('Connection refused'));

    await dispatchSession(baseData);

    expect(mockSendSessionStart).toHaveBeenCalledWith(baseData.sessionId, baseData);
    expect(mockEnqueueSession).toHaveBeenCalledWith(baseData);
  });

  it('passes all job data fields through to sendSessionStart', async () => {
    mockConfig.DIRECT_DISPATCH = true;
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

  it('does not call sendSessionStart when DIRECT_DISPATCH is false even with full data', async () => {
    mockConfig.DIRECT_DISPATCH = false;
    const fullData: RunSessionJobData = {
      sessionId: '00000000-0000-0000-0000-000000000002',
      resumeRef: 'ref-123',
      resumePrompt: 'Continue',
    };

    await dispatchSession(fullData);

    expect(mockEnqueueSession).toHaveBeenCalledWith(fullData);
    expect(mockSendSessionStart).not.toHaveBeenCalled();
  });
});
