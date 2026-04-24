/**
 * Demo mode tests for session-service.
 *
 * Strategy: stub NEXT_PUBLIC_DEMO_MODE=true and exercise the real service
 * functions so that the isDemoMode() branch actually routes to the demo shadow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Setup demo mode env before any imports --------------------------------
// vi.stubEnv is called in beforeEach, but module-level mocks must also handle
// the env. We mock the demo flag module to return true, which simulates the
// env being set before module evaluation.

vi.mock('@/lib/demo/flag', () => ({
  isDemoMode: vi.fn(() => true),
}));

// We also need to prevent the DB safety-net from throwing. The real
// src/lib/db/index.ts throws in demo mode. Since we mock the flag to true
// and demo.ts shadows the service (never reaching db), this should be fine —
// but mock db anyway to be safe.
vi.mock('@/lib/db', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('DB should not be accessed in demo mode');
      },
    },
  ),
}));

// Also mock realtime deps that session-service imports at the top level
vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionControl: vi.fn(),
  sendSessionEvent: vi.fn(),
}));

vi.mock('@/lib/services/session-dispatch', () => ({
  dispatchSession: vi.fn(),
}));

vi.mock('@/lib/utils/fs-utils', () => ({
  safeUnlinkMany: vi.fn(),
}));

import {
  getSession,
  getSessionWithDetails,
  listSessions,
  listSessionsByProject,
  listFreeChatsByProject,
  listTaskSessionsByProject,
  searchSessions,
  getSessionLogInfo,
  getSessionStatus,
  createSession,
  cancelSession,
  deleteSession,
  deleteSessions,
  forkSession,
  restartFreshFromSession,
} from '@/lib/services/session-service';

import {
  DEMO_SESSION_CLAUDE_EXPLORE,
  DEMO_SESSION_CODEX_REFACTOR,
  DEMO_SESSION_GEMINI_PLAN,
} from '@/lib/services/session-service.demo';

const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';
const CODEX_SESSION_ID = '88888888-8888-4888-a888-888888888888';
const GEMINI_SESSION_ID = '99999999-9999-4999-a999-999999999999';

describe('session-service (demo mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Fixture shape -------------------------------------------------------

  describe('demo fixtures', () => {
    it('claude-explore fixture has correct id and status', () => {
      expect(DEMO_SESSION_CLAUDE_EXPLORE.id).toBe(CLAUDE_SESSION_ID);
      expect(DEMO_SESSION_CLAUDE_EXPLORE.status).toBe('active');
      expect(DEMO_SESSION_CLAUDE_EXPLORE.kind).toBe('conversation');
    });

    it('codex-refactor fixture has status ended with endedAt', () => {
      expect(DEMO_SESSION_CODEX_REFACTOR.id).toBe(CODEX_SESSION_ID);
      expect(DEMO_SESSION_CODEX_REFACTOR.status).toBe('ended');
      expect(DEMO_SESSION_CODEX_REFACTOR.endedAt).toBeInstanceOf(Date);
    });

    it('gemini-plan fixture has awaiting_input status', () => {
      expect(DEMO_SESSION_GEMINI_PLAN.id).toBe(GEMINI_SESSION_ID);
      expect(DEMO_SESSION_GEMINI_PLAN.status).toBe('awaiting_input');
    });

    it('fixtures have required non-nullable fields', () => {
      for (const session of [
        DEMO_SESSION_CLAUDE_EXPLORE,
        DEMO_SESSION_CODEX_REFACTOR,
        DEMO_SESSION_GEMINI_PLAN,
      ]) {
        expect(session.id).toBeTruthy();
        expect(session.agentId).toBeTruthy();
        expect(session.kind).toBeTruthy();
        expect(session.status).toBeTruthy();
        expect(session.permissionMode).toBeTruthy();
        expect(session.createdAt).toBeInstanceOf(Date);
        expect(typeof session.eventSeq).toBe('number');
        expect(typeof session.totalTurns).toBe('number');
        expect(typeof session.autoResumeCount).toBe('number');
        expect(Array.isArray(session.allowedTools)).toBe(true);
      }
    });

    it('claude-explore has realistic token usage', () => {
      expect(typeof DEMO_SESSION_CLAUDE_EXPLORE.totalCostUsd).toBe('string');
    });
  });

  // ---- Service function routing -------------------------------------------

  describe('getSession', () => {
    it('returns demo session for known claude id', async () => {
      const session = await getSession(CLAUDE_SESSION_ID);
      expect(session.id).toBe(CLAUDE_SESSION_ID);
      expect(session.status).toBe('active');
    });

    it('returns demo session for known codex id', async () => {
      const session = await getSession(CODEX_SESSION_ID);
      expect(session.id).toBe(CODEX_SESSION_ID);
    });

    it('throws NotFoundError for unknown id in demo mode', async () => {
      await expect(getSession('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });
  });

  describe('getSessionWithDetails', () => {
    it('returns session with projectName for claude session', async () => {
      const detail = await getSessionWithDetails(CLAUDE_SESSION_ID);
      expect(detail.id).toBe(CLAUDE_SESSION_ID);
      expect(detail.agentName).toBeTruthy();
      expect(typeof detail.projectName).toBe('string');
    });

    it('throws for unknown id', async () => {
      await expect(getSessionWithDetails('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });
  });

  describe('listSessions', () => {
    it('returns all 3 demo sessions when no filters', async () => {
      const result = await listSessions();
      expect(result.data).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
    });

    it('filters by agentId', async () => {
      const claudeAgentId = '11111111-1111-4111-a111-111111111111';
      const result = await listSessions({ agentId: claudeAgentId });
      expect(result.data.every((s) => s.agentId === claudeAgentId)).toBe(true);
    });

    it('filters by status', async () => {
      const result = await listSessions({ status: 'ended' });
      expect(result.data.every((s) => s.status === 'ended')).toBe(true);
    });

    it('returns SessionSummary shape with agentName', async () => {
      const result = await listSessions();
      for (const item of result.data) {
        expect(typeof item.id).toBe('string');
        expect(typeof item.status).toBe('string');
        expect(typeof item.kind).toBe('string');
        expect(typeof item.agentId).toBe('string');
        expect(item.createdAt).toBeInstanceOf(Date);
      }
    });
  });

  describe('listSessionsByProject', () => {
    it('returns sessions for agendo project', async () => {
      const agendoProjectId = '44444444-4444-4444-a444-444444444444';
      const result = await listSessionsByProject(agendoProjectId, 'free-chats');
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((s) => s.id)).toBe(true);
    });

    it('returns empty array for unknown project', async () => {
      const result = await listSessionsByProject(
        '00000000-0000-0000-0000-000000000099',
        'free-chats',
      );
      expect(result).toHaveLength(0);
    });
  });

  describe('searchSessions', () => {
    it('returns matching sessions for query "reconnect"', async () => {
      const results = await searchSessions('reconnect');
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns empty array for no match', async () => {
      const results = await searchSessions('zzz-no-match-xyz');
      expect(results).toHaveLength(0);
    });

    it('returns SearchSessionResult shape', async () => {
      const results = await searchSessions('session');
      for (const r of results) {
        expect(typeof r.id).toBe('string');
        expect(typeof r.title).toBe('string');
        expect(typeof r.status).toBe('string');
        expect(typeof r.agentName).toBe('string');
      }
    });
  });

  describe('getSessionLogInfo', () => {
    it('returns log info for known session', async () => {
      const info = await getSessionLogInfo(CLAUDE_SESSION_ID);
      expect(info).not.toBeNull();
      expect(typeof info!.status).toBe('string');
    });

    it('returns null for unknown session', async () => {
      const info = await getSessionLogInfo('00000000-0000-0000-0000-000000000099');
      expect(info).toBeNull();
    });
  });

  describe('getSessionStatus', () => {
    it('returns status for known session', async () => {
      const result = await getSessionStatus(CODEX_SESSION_ID);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('ended');
    });

    it('returns null for unknown session', async () => {
      const result = await getSessionStatus('00000000-0000-0000-0000-000000000099');
      expect(result).toBeNull();
    });
  });

  // ---- Mutations — no side-effects in demo mode ---------------------------

  describe('createSession (demo mode noop)', () => {
    it('returns a stub session without hitting DB', async () => {
      const result = await createSession({
        agentId: '11111111-1111-4111-a111-111111111111',
        kind: 'conversation',
      });
      expect(result.id).toBeTruthy();
      expect(result.status).toBe('idle');
    });
  });

  describe('cancelSession (demo mode noop)', () => {
    it('resolves without throwing', async () => {
      await expect(cancelSession(CLAUDE_SESSION_ID)).resolves.toBeUndefined();
    });
  });

  describe('deleteSession (demo mode noop)', () => {
    it('resolves without throwing', async () => {
      await expect(deleteSession(CODEX_SESSION_ID)).resolves.toBeUndefined();
    });
  });

  describe('deleteSessions (demo mode noop)', () => {
    it('returns zero deleted count', async () => {
      const result = await deleteSessions([CLAUDE_SESSION_ID, CODEX_SESSION_ID]);
      expect(result.deletedCount).toBe(0);
      expect(result.skippedIds).toEqual([]);
    });
  });

  describe('forkSession (demo mode stub)', () => {
    it('returns a forked session with a new id', async () => {
      const fork = await forkSession(CLAUDE_SESSION_ID);
      expect(fork.id).toBeTruthy();
      expect(fork.id).not.toBe(CLAUDE_SESSION_ID);
      expect(fork.parentSessionId).toBe(CLAUDE_SESSION_ID);
    });

    it('fork status is idle', async () => {
      const fork = await forkSession(CLAUDE_SESSION_ID);
      expect(fork.status).toBe('idle');
    });

    it('fork inherits agentId and projectId from parent', async () => {
      const fork = await forkSession(CLAUDE_SESSION_ID);
      const parent = await getSession(CLAUDE_SESSION_ID);
      expect(fork.agentId).toBe(parent.agentId);
      expect(fork.projectId).toBe(parent.projectId);
    });

    it('fork stores forkSourceRef when parent has sessionRef', async () => {
      const fork = await forkSession(CLAUDE_SESSION_ID);
      const parent = await getSession(CLAUDE_SESSION_ID);
      expect(fork.forkSourceRef).toBe(parent.sessionRef);
    });

    it('fork stores forkPointUuid when resumeAt is passed', async () => {
      const resumeAt = 'some-uuid-to-resume-at';
      const fork = await forkSession(CLAUDE_SESSION_ID, resumeAt);
      expect(fork.forkPointUuid).toBe(resumeAt);
    });

    it('fork stores initialPrompt when provided', async () => {
      const fork = await forkSession(CLAUDE_SESSION_ID, undefined, 'My forked prompt');
      expect(fork.initialPrompt).toBe('My forked prompt');
    });

    it('throws for unknown parent id', async () => {
      await expect(forkSession('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });
  });

  describe('restartFreshFromSession (demo mode stub)', () => {
    it('returns a new session with a different id', async () => {
      const fresh = await restartFreshFromSession(
        CLAUDE_SESSION_ID,
        'Plan content here',
        'bypassPermissions',
      );
      expect(fresh.id).toBeTruthy();
      expect(fresh.id).not.toBe(CLAUDE_SESSION_ID);
    });

    it('new session has idle status', async () => {
      const fresh = await restartFreshFromSession(CLAUDE_SESSION_ID, null, 'acceptEdits');
      expect(fresh.status).toBe('idle');
    });

    it('new session inherits agentId and projectId from parent', async () => {
      const fresh = await restartFreshFromSession(CLAUDE_SESSION_ID, null, 'bypassPermissions');
      const parent = await getSession(CLAUDE_SESSION_ID);
      expect(fresh.agentId).toBe(parent.agentId);
      expect(fresh.projectId).toBe(parent.projectId);
    });

    it('new session has conversation kind (not plan)', async () => {
      const fresh = await restartFreshFromSession(CODEX_SESSION_ID, 'Some plan', 'default');
      expect(fresh.kind).toBe('conversation');
    });

    it('new session uses the passed permissionMode', async () => {
      const fresh = await restartFreshFromSession(CLAUDE_SESSION_ID, null, 'acceptEdits');
      expect(fresh.permissionMode).toBe('acceptEdits');
    });

    it('initialPrompt contains plan content when provided', async () => {
      const fresh = await restartFreshFromSession(
        CLAUDE_SESSION_ID,
        'My plan',
        'bypassPermissions',
      );
      expect(fresh.initialPrompt).toContain('My plan');
    });

    it('initialPrompt is fallback message when planContent is null', async () => {
      const fresh = await restartFreshFromSession(CLAUDE_SESSION_ID, null, 'bypassPermissions');
      expect(fresh.initialPrompt).toBeTruthy();
      expect(typeof fresh.initialPrompt).toBe('string');
    });

    it('throws for unknown parent id', async () => {
      await expect(
        restartFreshFromSession('00000000-0000-0000-0000-000000000000', null, 'default'),
      ).rejects.toThrow();
    });
  });

  describe('listFreeChatsByProject (demo mode)', () => {
    it('returns sessions for known project', async () => {
      const agendoProjectId = '44444444-4444-4444-a444-444444444444';
      const result = await listFreeChatsByProject(agendoProjectId);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns only sessions with null taskId (free chats)', async () => {
      const agendoProjectId = '44444444-4444-4444-a444-444444444444';
      const result = await listFreeChatsByProject(agendoProjectId);
      expect(
        result.every(
          (s) =>
            !('taskId' in s) ||
            (s as { taskId: unknown }).taskId === null ||
            (s as { taskId: unknown }).taskId === undefined,
        ),
      ).toBe(true);
    });

    it('returns empty array for unknown project', async () => {
      const result = await listFreeChatsByProject('00000000-0000-0000-0000-000000000099');
      expect(result).toHaveLength(0);
    });

    it('returns SessionListItem shape', async () => {
      const agendoProjectId = '44444444-4444-4444-a444-444444444444';
      const result = await listFreeChatsByProject(agendoProjectId);
      for (const item of result) {
        expect(typeof item.id).toBe('string');
        expect(typeof item.status).toBe('string');
        expect(typeof item.agentName).toBe('string');
        expect(item.createdAt).toBeInstanceOf(Date);
      }
    });
  });

  describe('listTaskSessionsByProject (demo mode)', () => {
    it('returns array for known project', async () => {
      const agendoProjectId = '44444444-4444-4444-a444-444444444444';
      const result = await listTaskSessionsByProject(agendoProjectId);
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns empty array for unknown project', async () => {
      const result = await listTaskSessionsByProject('00000000-0000-0000-0000-000000000099');
      expect(result).toHaveLength(0);
    });

    it('respects the limit parameter', async () => {
      const agendoProjectId = '44444444-4444-4444-a444-444444444444';
      const result = await listTaskSessionsByProject(agendoProjectId, 1);
      expect(result.length).toBeLessThanOrEqual(1);
    });
  });
});
