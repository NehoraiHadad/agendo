/**
 * demo-smoke.test.ts — Integration walker for demo-mode end-to-end smoke.
 *
 * Exercises every demo service layer function and every demo API route handler
 * (session events, board SSE, brainstorm events, session history) using direct
 * handler invocation — no Playwright, no real HTTP server.
 *
 * Pattern: mirrors the per-service demo tests (Phases 1-2), collected into
 * one file with a shared mock header.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoist mock values so they're available before vi.mock factory evaluation
// ---------------------------------------------------------------------------

const { mockDb } = vi.hoisted(() => ({
  mockDb: new Proxy(
    {},
    {
      get() {
        throw new Error('[demo-smoke] DB accessed — demo short-circuit failed');
      },
    },
  ),
}));

// ---------------------------------------------------------------------------
// Module mocks — UNION of all transitive deps across service & route imports.
// Must be declared before any non-mock imports.
// ---------------------------------------------------------------------------

// Core
vi.mock('@/lib/demo/flag', () => ({
  isDemoMode: vi.fn(() => true),
}));
vi.mock('@/lib/db', () => ({ db: mockDb }));

// Session-service transitive deps
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

// Agent-service transitive deps
vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));
vi.mock('@/lib/discovery/schema-extractor', () => ({
  getHelpText: vi.fn(),
  quickParseHelp: vi.fn(),
}));

// Brainstorm-service transitive deps
vi.mock('@/lib/brainstorm/leader', () => ({
  selectLeader: vi.fn(() => null),
}));
vi.mock('@/lib/worker/brainstorm-personas', () => ({
  inferProviderFromAgentSlug: vi.fn(() => 'claude'),
}));

// Plan-service transitive deps
vi.mock('@/lib/services/artifact-service', () => ({
  createArtifact: vi.fn(),
}));
vi.mock('@/lib/services/session-helpers', () => ({
  createAndEnqueueSession: vi.fn(),
}));
vi.mock('@/lib/worker/agent-utils', () => ({
  getBinaryName: vi.fn(() => 'claude'),
}));
vi.mock('@/lib/worker/session-preambles', () => ({
  buildPlanContext: vi.fn(() => 'mock plan context'),
  generatePlanConversationPreamble: vi.fn(() => ({
    prompt: 'mock preamble',
    permissionMode: 'plan',
  })),
}));
vi.mock('@/lib/utils/git', () => ({
  getGitHead: vi.fn(() => null),
}));

// Project-service transitive deps
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('@/lib/services/github-service', () => ({
  detectGitHubRepo: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/services/project-path-service', () => ({
  getProjectPathStatus: vi.fn().mockResolvedValue({ status: 'exists', normalizedPath: '/tmp/x' }),
  validateProjectPath: vi.fn().mockResolvedValue('/tmp/x'),
}));

// API route mocks for non-demo path
vi.mock('@/lib/api/create-sse-proxy', () => ({
  createSSEProxyHandler: vi.fn(() =>
    vi.fn().mockResolvedValue(new Response('proxy', { status: 200 })),
  ),
}));
vi.mock('@/lib/services/session-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/session-service')>();
  return {
    ...actual,
    // These are overridden for the route-level tests only; service-layer tests
    // use the actual demo-shadowed implementations (which never hit the DB).
    getSession: vi.fn().mockResolvedValue({ id: 'irrelevant', status: 'active' }),
    getSessionLogInfo: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// action-utils needs next/cache
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// ---------------------------------------------------------------------------
// Route + fixture imports (after all mocks)
// ---------------------------------------------------------------------------

import { GET as sessionEventsGET } from '@/app/api/sessions/[id]/events/route';
import { GET as sessionHistoryGET } from '@/app/api/sessions/[id]/history/route';
import { GET as boardGET } from '@/app/api/sse/board/route';
import { GET as brainstormEventsGET } from '@/app/api/brainstorms/[id]/events/route';

import { DEMO_SESSION_EVENTS } from '@/lib/demo/fixtures/sessions';
import { DEMO_BRAINSTORM_ROOM_ID } from '@/lib/services/brainstorm-service.demo';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';
const CODEX_SESSION_ID = '88888888-8888-4888-a888-888888888888';
const GEMINI_SESSION_ID = '99999999-9999-4999-a999-999999999999';
const UNKNOWN_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const SSE_CONTENT_TYPE = 'text/event-stream';
const NO_CACHE = 'no-cache, no-transform';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionRequest(
  sessionId: string,
  path: string,
): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(`http://localhost${path}`);
  const ctx = { params: Promise.resolve({ id: sessionId }) };
  return [req, ctx];
}

const decoder = new TextDecoder();

async function readFirstFrames(stream: ReadableStream<Uint8Array>, count = 3): Promise<string[]> {
  const reader = stream.getReader();
  const frames: string[] = [];
  let buffer = '';

  while (frames.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part && part.trim()) {
        frames.push(part + '\n\n');
      }
    }
    buffer = parts[parts.length - 1] ?? '';
  }

  reader.cancel().catch(() => undefined);
  return frames;
}

// ---------------------------------------------------------------------------
// Top-level suite
// ---------------------------------------------------------------------------

describe('demo-mode end-to-end smoke', () => {
  beforeAll(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // Service layer
  // -------------------------------------------------------------------------

  describe('service layer', () => {
    it('task-service.listTasksBoardItems returns fixture tasks', async () => {
      const { listTasksBoardItems } = await import('@/lib/services/task-service');
      const result = await listTasksBoardItems([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      result.forEach((item) => {
        expect(typeof item.id).toBe('string');
        expect(typeof item.title).toBe('string');
        expect(typeof item.status).toBe('string');
        expect(typeof item.subtaskTotal).toBe('number');
        expect(typeof item.subtaskDone).toBe('number');
      });
    });

    it('session-service.listSessions returns 3 fixture sessions', async () => {
      const { listSessions } = await import('@/lib/services/session-service');
      const result = await listSessions();
      expect(result.data).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('project-service.listProjects returns 3 fixture projects', async () => {
      const { listProjects } = await import('@/lib/services/project-service');
      const result = await listProjects();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
      result.forEach((p) => {
        expect(typeof p.id).toBe('string');
        expect(typeof p.name).toBe('string');
        expect(typeof p.rootPath).toBe('string');
      });
    });

    it('dashboard-service.getDashboardStats returns aggregated fixture stats', async () => {
      const { getDashboardStats } = await import('@/lib/services/dashboard-service');
      const result = await getDashboardStats();
      expect(typeof result.totalTasks).toBe('number');
      expect(result.totalTasks).toBe(15);
      expect(typeof result.projectCount).toBe('number');
      expect(result.projectCount).toBe(3);
      expect(Array.isArray(result.recentEvents)).toBe(true);
      expect(Array.isArray(result.agentHealth)).toBe(true);
      expect(result.agentHealth).toHaveLength(3);
    });

    it('brainstorm-service.listBrainstorms returns 1 fixture room', async () => {
      const { listBrainstorms } = await import('@/lib/services/brainstorm-service');
      const result = await listBrainstorms();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      const room = result[0]!;
      expect(room.id).toBe(DEMO_BRAINSTORM_ROOM_ID);
      expect(typeof room.title).toBe('string');
    });

    it('plan-service.listPlans returns 1 fixture plan', async () => {
      const { listPlans } = await import('@/lib/services/plan-service');
      const result = await listPlans();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      const plan = result[0]!;
      expect(typeof plan.id).toBe('string');
      expect(typeof plan.title).toBe('string');
    });

    it('agent-service.listAgents returns 3 fixture agents', async () => {
      const { listAgents } = await import('@/lib/services/agent-service');
      const result = await listAgents();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
      result.forEach((agent) => {
        expect(typeof agent.id).toBe('string');
        expect(typeof agent.name).toBe('string');
        expect(typeof agent.slug).toBe('string');
      });
    });
  });

  // -------------------------------------------------------------------------
  // API routes
  // -------------------------------------------------------------------------

  describe('api routes', () => {
    it('GET /api/sessions/[id]/events demo session emits SSE frames', async () => {
      vi.useFakeTimers();

      const [req, ctx] = makeSessionRequest(
        CLAUDE_SESSION_ID,
        `/api/sessions/${CLAUDE_SESSION_ID}/events`,
      );
      const res = await sessionEventsGET(req, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
      expect(res.headers.get('cache-control')).toBe(NO_CACHE);
      expect(res.body).not.toBeNull();

      // Advance timers to flush queued events
      vi.advanceTimersByTime(300_000);

      const frames = await readFirstFrames(res.body!, 2);
      const eventFrames = frames.filter((f) => f.startsWith('id:'));
      expect(eventFrames.length).toBeGreaterThan(0);

      const first = eventFrames[0]!;
      // Session events are unnamed (worker format) — discriminant is in `data`.
      expect(first).not.toContain('\nevent:');
      expect(first).toContain('data:');

      vi.useRealTimers();
    });

    it('GET /api/sse/board demo emits initial snapshot', async () => {
      vi.useFakeTimers();

      const req = new NextRequest('http://localhost/api/sse/board');
      const res = await boardGET(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
      expect(res.body).not.toBeNull();

      // Advance past the snapshot (fires at atMs=0)
      vi.advanceTimersByTime(500);

      const frames = await readFirstFrames(res.body!, 1);
      const eventFrames = frames.filter((f) => f.startsWith('id:'));
      expect(eventFrames.length).toBeGreaterThanOrEqual(1);

      const firstFrame = eventFrames[0]!;
      expect(firstFrame).toContain('event: snapshot');

      const dataLine = firstFrame.split('\n').find((l) => l.startsWith('data:'));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!.slice('data:'.length).trim()) as {
        type: string;
        tasks: unknown[];
      };
      expect(payload.type).toBe('snapshot');
      expect(Array.isArray(payload.tasks)).toBe(true);
      expect(payload.tasks.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });

    it('GET /api/brainstorms/[id]/events demo emits SSE frames', async () => {
      vi.useFakeTimers();

      const req = new NextRequest(
        `http://localhost/api/brainstorms/${DEMO_BRAINSTORM_ROOM_ID}/events`,
      );
      const ctx = { params: Promise.resolve({ id: DEMO_BRAINSTORM_ROOM_ID }) };
      const res = await brainstormEventsGET(req, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
      expect(res.headers.get('cache-control')).toBe(NO_CACHE);
      expect(res.body).not.toBeNull();

      vi.advanceTimersByTime(300_000);

      const frames = await readFirstFrames(res.body!, 2);
      const eventFrames = frames.filter((f) => f.startsWith('id:'));
      expect(eventFrames.length).toBeGreaterThan(0);

      const first = eventFrames[0]!;
      // Brainstorm events are unnamed (worker format) — discriminant is in `data`.
      expect(first).not.toContain('\nevent:');
      expect(first).toContain('data:');

      vi.useRealTimers();
    });

    it('GET /api/sessions/[id]/history demo returns JSON array for known id', async () => {
      const [req, ctx] = makeSessionRequest(
        CLAUDE_SESSION_ID,
        `/api/sessions/${CLAUDE_SESSION_ID}/history`,
      );
      const res = await sessionHistoryGET(req, ctx);

      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('sessionId', CLAUDE_SESSION_ID);
      expect(body).toHaveProperty('events');
      expect(body).toHaveProperty('hasMore');
      expect(body).toHaveProperty('totalCount');
      expect(Array.isArray(body.events)).toBe(true);
      expect(typeof body.hasMore).toBe('boolean');
      expect(typeof body.totalCount).toBe('number');

      // All demo session IDs are represented in history
      const allDemoIds = Object.keys(DEMO_SESSION_EVENTS);
      expect(allDemoIds).toContain(CLAUDE_SESSION_ID);
    });

    it('GET /api/sessions/[id]/history demo returns 404 for unknown id', async () => {
      const [req, ctx] = makeSessionRequest(UNKNOWN_UUID, `/api/sessions/${UNKNOWN_UUID}/history`);
      const res = await sessionHistoryGET(req, ctx);
      expect(res.status).toBe(404);
    });

    it('GET /api/sessions/[id]/events emits SSE for codex session id', async () => {
      vi.useFakeTimers();

      const [req, ctx] = makeSessionRequest(
        CODEX_SESSION_ID,
        `/api/sessions/${CODEX_SESSION_ID}/events`,
      );
      const res = await sessionEventsGET(req, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);

      vi.advanceTimersByTime(300_000);
      if (res.body) res.body.cancel().catch(() => undefined);

      vi.useRealTimers();
    });

    it('GET /api/sessions/[id]/events emits SSE for gemini session id', async () => {
      vi.useFakeTimers();

      const [req, ctx] = makeSessionRequest(
        GEMINI_SESSION_ID,
        `/api/sessions/${GEMINI_SESSION_ID}/events`,
      );
      const res = await sessionEventsGET(req, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);

      vi.advanceTimersByTime(300_000);
      if (res.body) res.body.cancel().catch(() => undefined);

      vi.useRealTimers();
    });

    it('GET /api/sessions/[id]/events returns 404 for unknown demo id', async () => {
      const [req, ctx] = makeSessionRequest(UNKNOWN_UUID, `/api/sessions/${UNKNOWN_UUID}/events`);
      const res = await sessionEventsGET(req, ctx);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Action-utils short-circuit
  // -------------------------------------------------------------------------

  describe('action-utils short-circuit', () => {
    it('withAction returns success in demo without invoking handler', async () => {
      const { withAction } = await import('@/lib/actions/action-utils');
      const handler = vi.fn().mockResolvedValue({ id: 'should-not-be-called' });
      const action = withAction(handler);

      const result = await action({ some: 'input' });

      expect(handler).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('withValidatedAction returns success in demo even with invalid input', async () => {
      const { withValidatedAction } = await import('@/lib/actions/action-utils');
      const { z } = await import('zod');

      const schema = z.object({ name: z.string().min(1) });
      const handler = vi.fn().mockResolvedValue('ok');
      const action = withValidatedAction(schema, handler);

      // Pass deliberately invalid input — demo mode short-circuits before validation
      const result = await action({ name: 42, extra: 'garbage' });

      expect(handler).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('withAction does not revalidate paths in demo mode', async () => {
      const { withAction } = await import('@/lib/actions/action-utils');
      const { revalidatePath } = await import('next/cache');
      const mockRevalidate = vi.mocked(revalidatePath);
      const countBefore = mockRevalidate.mock.calls.length;

      const handler = vi.fn().mockResolvedValue('done');
      const action = withAction(handler, { revalidate: '/tasks' });
      await action({});

      // No revalidation should occur in demo mode
      expect(mockRevalidate.mock.calls.length).toBe(countBefore);
    });
  });
});
