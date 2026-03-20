import { describe, it, expect } from 'vitest';
import {
  mapAppServerEventToPayloads,
  isAppServerSyntheticEvent,
  type AppServerSyntheticEvent,
} from '../codex-app-server-event-mapper';

describe('mapAppServerEventToPayloads', () => {
  // -----------------------------------------------------------------------
  // as:usage → agent:usage
  // -----------------------------------------------------------------------
  describe('as:usage → agent:usage', () => {
    it('maps usage event with real context window', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:usage',
        used: 45000,
        size: 128000,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([{ type: 'agent:usage', used: 45000, size: 128000 }]);
    });

    it('maps usage event with default 200K fallback', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:usage',
        used: 10000,
        size: 200000,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([{ type: 'agent:usage', used: 10000, size: 200000 }]);
    });
  });

  // -----------------------------------------------------------------------
  // as:diff-update → system:info
  // -----------------------------------------------------------------------
  describe('as:diff-update → system:info', () => {
    it('maps diff update to system:info with diff formatting', () => {
      const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1,2 @@\n foo\n+bar';
      const event: AppServerSyntheticEvent = {
        type: 'as:diff-update',
        diff,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'system:info',
        message: expect.stringContaining('```diff'),
      });
      expect((result[0] as { message: string }).message).toContain(diff);
    });

    it('returns empty array for empty diff', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:diff-update',
        diff: '',
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Existing events still work
  // -----------------------------------------------------------------------
  describe('existing event types', () => {
    it('maps thread.started to session:init', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:thread.started',
        threadId: 'thread-1',
        model: 'o4-mini',
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([
        {
          type: 'session:init',
          sessionRef: 'thread-1',
          slashCommands: [],
          mcpServers: [],
          model: 'o4-mini',
        },
      ]);
    });

    it('maps turn.completed success to agent:result', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:turn.completed',
        status: 'completed',
        error: null,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([
        {
          type: 'agent:result',
          costUsd: null,
          turns: 1,
          durationMs: null,
        },
      ]);
    });

    it('maps turn.completed failure to agent:result with error', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:turn.completed',
        status: 'failed',
        error: { message: 'Rate limited' },
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        type: 'agent:result',
        isError: true,
        errors: ['Rate limited'],
      });
      expect(result[1]).toMatchObject({ type: 'system:error' });
    });

    it('maps turn.completed interrupted to compact-start', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:turn.completed',
        status: 'interrupted',
        error: null,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([{ type: 'system:compact-start', trigger: 'auto' }]);
    });
  });
});

describe('isAppServerSyntheticEvent', () => {
  it('detects as: prefixed events', () => {
    expect(isAppServerSyntheticEvent({ type: 'as:usage', used: 0, size: 0 })).toBe(true);
    expect(isAppServerSyntheticEvent({ type: 'as:diff-update', diff: '' })).toBe(true);
    expect(isAppServerSyntheticEvent({ type: 'as:thread.started' })).toBe(true);
  });

  it('rejects non-synthetic events', () => {
    expect(isAppServerSyntheticEvent({ type: 'agent:text', text: '' })).toBe(false);
    expect(isAppServerSyntheticEvent({ type: 'session:init' })).toBe(false);
    expect(isAppServerSyntheticEvent({})).toBe(false);
  });
});
