/**
 * Demo mode tests for:
 *   GET /api/sessions/[id]/events  — SSE replay from DEMO_SESSION_EVENTS
 *   GET /api/sessions/[id]/history — JSON history from DEMO_SESSION_EVENTS
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoist mocks so they run before any imports below
// ---------------------------------------------------------------------------

vi.mock('@/lib/api/create-sse-proxy', () => ({
  createSSEProxyHandler: vi.fn(() =>
    vi.fn().mockResolvedValue(new Response('proxy', { status: 200 })),
  ),
}));

vi.mock('@/lib/services/session-service', () => ({
  getSession: vi.fn().mockResolvedValue({ id: 'irrelevant', status: 'active' }),
  getSessionLogInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({ db: {} }));

// ---------------------------------------------------------------------------
// Route imports (after mocks)
// ---------------------------------------------------------------------------

import { GET as eventsGET } from '../events/route';
import { GET as historyGET } from '../history/route';
import { DEMO_SESSION_EVENTS } from '@/lib/demo/fixtures/sessions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Known demo session IDs from fixtures/sessions/index.ts
const DEMO_ID = '77777777-7777-4777-a777-777777777777'; // claudeExploreEvents
const UNKNOWN_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const SSE_CONTENT_TYPE = 'text/event-stream';
const NO_CACHE = 'no-cache, no-transform';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url: string, id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(url);
  const ctx = { params: Promise.resolve({ id }) };
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

    // Split on double-newline (SSE frame boundary)
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
// Tests: GET /api/sessions/[id]/events (demo mode)
// ---------------------------------------------------------------------------

describe('GET /api/sessions/[id]/events — demo mode', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 404 for unknown demo session ID', async () => {
    const [req, ctx] = makeRequest(
      `http://localhost/api/sessions/${UNKNOWN_UUID}/events`,
      UNKNOWN_UUID,
    );
    const res = await eventsGET(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns SSE headers for a known demo session', async () => {
    const [req, ctx] = makeRequest(`http://localhost/api/sessions/${DEMO_ID}/events`, DEMO_ID);
    const res = await eventsGET(req, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
    expect(res.headers.get('cache-control')).toBe(NO_CACHE);
    expect(res.headers.get('connection')).toBe('keep-alive');
    // Close stream immediately
    if (res.body) res.body.cancel().catch(() => undefined);
  });

  it('streams unnamed SSE frames with id/data framing (worker format)', async () => {
    vi.useFakeTimers();

    const [req, ctx] = makeRequest(`http://localhost/api/sessions/${DEMO_ID}/events`, DEMO_ID);
    const res = await eventsGET(req, ctx);
    expect(res.body).not.toBeNull();

    // Advance timers past all events so they enqueue quickly
    vi.advanceTimersByTime(300_000);

    const frames = await readFirstFrames(res.body!, 2);
    expect(frames.length).toBeGreaterThanOrEqual(1);

    // First non-heartbeat frame should have SSE id: field
    const eventFrames = frames.filter((f) => f.startsWith('id:'));
    expect(eventFrames.length).toBeGreaterThan(0);

    // Frames must be unnamed (no `event:` line) so native EventSource.onmessage
    // fires — this matches the worker's real SSE producer format.
    const first = eventFrames[0];
    expect(first).not.toContain('\nevent:');
    expect(first).toContain('data:');

    // The envelope fields (id, sessionId, ts) must be embedded in the JSON
    // data, so the frontend reducer can dedup and timeline events.
    const dataLine = first.split('\n').find((l) => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.slice('data:'.length).trim()) as {
      id: number;
      sessionId: string;
      ts: number;
      type: string;
    };
    expect(parsed.id).toBe(1);
    expect(parsed.sessionId).toBe(DEMO_ID);
    expect(typeof parsed.ts).toBe('number');
    expect(typeof parsed.type).toBe('string');

    vi.useRealTimers();
  });

  it('does not invoke the proxy handler in demo mode', async () => {
    const { createSSEProxyHandler } = await import('@/lib/api/create-sse-proxy');
    const mockFactory = vi.mocked(createSSEProxyHandler);
    const callsBefore = mockFactory.mock.calls.length;

    const [req, ctx] = makeRequest(`http://localhost/api/sessions/${DEMO_ID}/events`, DEMO_ID);
    const res = await eventsGET(req, ctx);
    if (res.body) res.body.cancel().catch(() => undefined);

    // createSSEProxyHandler was called at module load time (to build the handler),
    // but the returned handler function should NOT be called in demo mode.
    const proxyHandler = mockFactory.mock.results[0]?.value as ReturnType<typeof vi.fn> | undefined;
    if (proxyHandler) {
      expect(proxyHandler).not.toHaveBeenCalled();
    }
    expect(mockFactory.mock.calls.length).toBe(callsBefore); // no new factory calls
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/sessions/[id]/history (demo mode)
// ---------------------------------------------------------------------------

describe('GET /api/sessions/[id]/history — demo mode', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 404 for unknown demo session ID', async () => {
    const [req, ctx] = makeRequest(
      `http://localhost/api/sessions/${UNKNOWN_UUID}/history`,
      UNKNOWN_UUID,
    );
    const res = await historyGET(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns JSON with correct SessionHistoryResult envelope shape', async () => {
    const [req, ctx] = makeRequest(`http://localhost/api/sessions/${DEMO_ID}/history`, DEMO_ID);
    const res = await historyGET(req, ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('sessionId', DEMO_ID);
    expect(body).toHaveProperty('events');
    expect(body).toHaveProperty('hasMore');
    expect(body).toHaveProperty('totalCount');
    expect(body).toHaveProperty('oldestSeq');
    expect(body).toHaveProperty('newestSeq');

    expect(Array.isArray(body.events)).toBe(true);
    expect(typeof body.hasMore).toBe('boolean');
    expect(typeof body.totalCount).toBe('number');
  });

  it('excludes ephemeral agent:text-delta events from history', async () => {
    const [req, ctx] = makeRequest(`http://localhost/api/sessions/${DEMO_ID}/history`, DEMO_ID);
    const res = await historyGET(req, ctx);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    const ephemeralEvents = body.events.filter(
      (e) => e.type === 'agent:text-delta' || e.type === 'agent:thinking-delta',
    );
    expect(ephemeralEvents).toHaveLength(0);
  });

  it('events have AgendoEvent envelope fields (id, sessionId, ts)', async () => {
    const [req, ctx] = makeRequest(`http://localhost/api/sessions/${DEMO_ID}/history`, DEMO_ID);
    const res = await historyGET(req, ctx);
    const body = (await res.json()) as {
      events: Array<{ id: unknown; sessionId: unknown; ts: unknown }>;
    };
    expect(body.events.length).toBeGreaterThan(0);

    for (const event of body.events) {
      expect(typeof event.id).toBe('number');
      expect(event.sessionId).toBe(DEMO_ID);
      expect(typeof event.ts).toBe('number');
    }
  });

  it('respects limit query param', async () => {
    const [req, ctx] = makeRequest(
      `http://localhost/api/sessions/${DEMO_ID}/history?limit=3`,
      DEMO_ID,
    );
    const res = await historyGET(req, ctx);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events.length).toBeLessThanOrEqual(3);
  });

  it('totalCount matches the number of non-ephemeral events in the fixture', async () => {
    const allEvents = DEMO_SESSION_EVENTS[DEMO_ID]!;
    const nonEphemeral = allEvents.filter(
      (e) => e.type !== 'agent:text-delta' && e.type !== 'agent:thinking-delta',
    );

    const [req, ctx] = makeRequest(`http://localhost/api/sessions/${DEMO_ID}/history`, DEMO_ID);
    const res = await historyGET(req, ctx);
    const body = (await res.json()) as { totalCount: number };
    expect(body.totalCount).toBe(nonEphemeral.length);
  });
});

// ---------------------------------------------------------------------------
// Tests: non-demo mode (flag off → proxy path preserved)
// ---------------------------------------------------------------------------

describe('GET /api/sessions/[id]/events — non-demo mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not return demo SSE when NEXT_PUBLIC_DEMO_MODE is not set', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
    const [req, ctx] = makeRequest(`http://localhost/api/sessions/${DEMO_ID}/events`, DEMO_ID);
    const res = await eventsGET(req, ctx);
    // Should go through the proxy path (mocked to return 200 with 'proxy' body)
    const text = await res.text();
    expect(text).toBe('proxy');
  });
});
