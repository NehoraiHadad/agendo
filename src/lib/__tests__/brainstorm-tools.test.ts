import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleBrainstormSignal, handleBrainstormGetState } from '@/lib/mcp/tools/brainstorm-tools';

// Mock the shared apiCall
vi.mock('@/lib/mcp/tools/shared', () => ({
  apiCall: vi.fn().mockResolvedValue({ ok: true }),
  wrapToolCall: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { apiCall } from '@/lib/mcp/tools/shared';
const mockApiCall = vi.mocked(apiCall);

describe('brainstorm-tools', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, AGENDO_SESSION_ID: 'test-session-123' };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('handleBrainstormSignal', () => {
    it('throws when AGENDO_SESSION_ID is not set', async () => {
      delete process.env.AGENDO_SESSION_ID;
      await expect(handleBrainstormSignal({ signal: 'done' })).rejects.toThrow(
        'AGENDO_SESSION_ID not set',
      );
    });

    it('sends done signal without requiring reason', async () => {
      await handleBrainstormSignal({ signal: 'done' });
      expect(mockApiCall).toHaveBeenCalledWith('/api/brainstorms/signal', {
        method: 'POST',
        body: {
          sessionId: 'test-session-123',
          signal: 'done',
          reason: undefined,
        },
      });
    });

    it('sends pass signal with reason', async () => {
      await handleBrainstormSignal({ signal: 'pass', reason: 'I agree with the approach' });
      expect(mockApiCall).toHaveBeenCalledWith('/api/brainstorms/signal', {
        method: 'POST',
        body: {
          sessionId: 'test-session-123',
          signal: 'pass',
          reason: 'I agree with the approach',
        },
      });
    });

    it('throws when pass signal has no reason', async () => {
      await expect(handleBrainstormSignal({ signal: 'pass' })).rejects.toThrow(
        "A reason is required when signaling 'pass'",
      );
      expect(mockApiCall).not.toHaveBeenCalled();
    });

    it('sends block signal with reason', async () => {
      await handleBrainstormSignal({ signal: 'block', reason: 'Security concern' });
      expect(mockApiCall).toHaveBeenCalledWith('/api/brainstorms/signal', {
        method: 'POST',
        body: {
          sessionId: 'test-session-123',
          signal: 'block',
          reason: 'Security concern',
        },
      });
    });

    it('throws when block signal has no reason', async () => {
      await expect(handleBrainstormSignal({ signal: 'block' })).rejects.toThrow(
        "A reason is required when signaling 'block'",
      );
      expect(mockApiCall).not.toHaveBeenCalled();
    });

    it('includes reason in done signal if provided', async () => {
      await handleBrainstormSignal({ signal: 'done', reason: 'Wrapping up' });
      expect(mockApiCall).toHaveBeenCalledWith('/api/brainstorms/signal', {
        method: 'POST',
        body: {
          sessionId: 'test-session-123',
          signal: 'done',
          reason: 'Wrapping up',
        },
      });
    });
  });

  describe('handleBrainstormGetState', () => {
    it('throws when AGENDO_SESSION_ID is not set', async () => {
      delete process.env.AGENDO_SESSION_ID;
      await expect(handleBrainstormGetState()).rejects.toThrow('AGENDO_SESSION_ID not set');
    });

    it('calls API with session ID as query param', async () => {
      await handleBrainstormGetState();
      expect(mockApiCall).toHaveBeenCalledWith('/api/brainstorms/state?sessionId=test-session-123');
    });

    it('encodes special characters in session ID', async () => {
      process.env.AGENDO_SESSION_ID = 'session with spaces & special=chars';
      await handleBrainstormGetState();
      expect(mockApiCall).toHaveBeenCalledWith(
        `/api/brainstorms/state?sessionId=${encodeURIComponent('session with spaces & special=chars')}`,
      );
    });
  });
});
