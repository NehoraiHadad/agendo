import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync } from 'fs';

vi.mock('fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  trackTeamCreation,
  trackTeamMessage,
  type TeamCreationEvent,
  type TeamMessageEvent,
} from '../team-telemetry';

describe('team telemetry', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOG_DIR = '/tmp/test-logs';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('trackTeamCreation', () => {
    it('writes creation event to JSONL file', () => {
      const event: TeamCreationEvent = {
        source: 'mcp',
        mode: 'agent_led',
        parentTaskId: 'task-1',
        memberCount: 3,
        hasLeadSession: true,
      };

      trackTeamCreation(event);

      expect(mkdirSync).toHaveBeenCalled();
      expect(appendFileSync).toHaveBeenCalledTimes(1);

      const [filePath, content] = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filePath).toContain('team-telemetry.jsonl');

      const parsed = JSON.parse((content as string).replace('\n', ''));
      expect(parsed.type).toBe('team_created');
      expect(parsed.source).toBe('mcp');
      expect(parsed.mode).toBe('agent_led');
      expect(parsed.memberCount).toBe(3);
      expect(parsed.hasLeadSession).toBe(true);
      expect(parsed.ts).toBeDefined();
    });
  });

  describe('trackTeamMessage', () => {
    it('writes message event to JSONL file', () => {
      const event: TeamMessageEvent = {
        parentTaskId: 'task-1',
        senderSessionId: 'session-1',
        recipientSessionId: 'session-2',
        direction: 'member_to_lead',
      };

      trackTeamMessage(event);

      expect(appendFileSync).toHaveBeenCalledTimes(1);

      const [, content] = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
      const parsed = JSON.parse((content as string).replace('\n', ''));
      expect(parsed.type).toBe('team_message');
      expect(parsed.direction).toBe('member_to_lead');
    });
  });

  it('does not throw on write failure', () => {
    (appendFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() =>
      trackTeamCreation({
        source: 'ui',
        mode: 'ui_led',
        parentTaskId: 'task-1',
        memberCount: 2,
        hasLeadSession: false,
      }),
    ).not.toThrow();
  });
});
