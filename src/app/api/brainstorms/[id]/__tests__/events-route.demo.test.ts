/**
 * Demo mode tests for:
 *   GET /api/brainstorms/[id]/events — SSE replay from DEMO_BRAINSTORM_ROOMS
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoist mocks before any imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/api/create-sse-proxy', () => ({
  createSSEProxyHandler: vi.fn(() =>
    vi.fn().mockResolvedValue(new Response('proxy', { status: 200 })),
  ),
}));

vi.mock('@/lib/db', () => ({ db: {} }));

// ---------------------------------------------------------------------------
// Route import (after mocks)
// ---------------------------------------------------------------------------

import { GET } from '../events/route';
import { DEMO_BRAINSTORM_ROOMS } from '@/lib/demo/fixtures/brainstorms';
import { DEMO_BRAINSTORM_ROOM_ID } from '@/lib/services/brainstorm-service.demo';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEMO_ROOM_ID = DEMO_BRAINSTORM_ROOM_ID;
const UNKNOWN_UUID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const SSE_CONTENT_TYPE = 'text/event-stream';
const NO_CACHE = 'no-cache, no-transform';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(roomId: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(`http://localhost/api/brainstorms/${roomId}/events`);
  const ctx = { params: Promise.resolve({ id: roomId }) };
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
// Tests: GET /api/brainstorms/[id]/events (demo mode)
// ---------------------------------------------------------------------------

describe('GET /api/brainstorms/[id]/events — demo mode', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 404 for unknown demo room ID', async () => {
    const [req, ctx] = makeRequest(UNKNOWN_UUID);
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns SSE headers for the known demo room', async () => {
    const [req, ctx] = makeRequest(DEMO_ROOM_ID);
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
    expect(res.headers.get('cache-control')).toBe(NO_CACHE);
    expect(res.headers.get('connection')).toBe('keep-alive');
    if (res.body) res.body.cancel().catch(() => undefined);
  });

  it('streams unnamed SSE frames with id/data framing (matches worker format)', async () => {
    vi.useFakeTimers();

    const [req, ctx] = makeRequest(DEMO_ROOM_ID);
    const res = await GET(req, ctx);
    expect(res.body).not.toBeNull();

    vi.advanceTimersByTime(300_000);

    const frames = await readFirstFrames(res.body!, 2);
    const eventFrames = frames.filter((f) => f.startsWith('id:'));
    expect(eventFrames.length).toBeGreaterThan(0);

    const first = eventFrames[0]!;
    // No `event:` line — the frontend uses EventSource.onmessage which only
    // fires for unnamed frames.
    expect(first).not.toContain('\nevent:');
    expect(first).toContain('data:');
    // Must have id: line
    expect(first).toMatch(/^id:\s*\d+/);

    vi.useRealTimers();
  });

  it('reconstructed payload includes roomId, id, and ts fields', async () => {
    vi.useFakeTimers();

    const [req, ctx] = makeRequest(DEMO_ROOM_ID);
    const res = await GET(req, ctx);
    expect(res.body).not.toBeNull();

    vi.advanceTimersByTime(300_000);

    const frames = await readFirstFrames(res.body!, 2);
    const eventFrames = frames.filter((f) => f.startsWith('id:'));
    expect(eventFrames.length).toBeGreaterThan(0);

    // Parse the data from the first event frame
    const firstFrame = eventFrames[0]!;
    const dataLine = firstFrame.split('\n').find((l) => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice('data:'.length).trim()) as Record<string, unknown>;

    // The reconstructed envelope must contain roomId, id, and ts
    expect(payload).toHaveProperty('roomId', DEMO_ROOM_ID);
    expect(payload).toHaveProperty('id');
    expect(payload).toHaveProperty('ts');
    expect(typeof payload.ts).toBe('number');

    vi.useRealTimers();
  });

  it('payload type field matches the brainstorm event type', async () => {
    vi.useFakeTimers();

    const [req, ctx] = makeRequest(DEMO_ROOM_ID);
    const res = await GET(req, ctx);
    expect(res.body).not.toBeNull();

    vi.advanceTimersByTime(300_000);

    const frames = await readFirstFrames(res.body!, 1);
    const eventFrames = frames.filter((f) => f.startsWith('id:'));
    expect(eventFrames.length).toBeGreaterThan(0);

    const firstFrame = eventFrames[0]!;
    // The discriminant now travels inside `data` (not an `event:` line)
    const dataLine = firstFrame.split('\n').find((l) => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice('data:'.length).trim()) as { type: string };

    // First fixture event type (sorted by atMs)
    const sorted = [...DEMO_BRAINSTORM_ROOMS[DEMO_ROOM_ID]!].sort((a, b) => a.atMs - b.atMs);
    expect(payload.type).toBe(sorted[0]!.type);

    vi.useRealTimers();
  });

  it('does not use the proxy handler in demo mode', async () => {
    const { createSSEProxyHandler } = await import('@/lib/api/create-sse-proxy');
    const mockFactory = vi.mocked(createSSEProxyHandler);
    const proxyHandler = mockFactory.mock.results[0]?.value as ReturnType<typeof vi.fn> | undefined;

    const [req, ctx] = makeRequest(DEMO_ROOM_ID);
    const res = await GET(req, ctx);
    if (res.body) res.body.cancel().catch(() => undefined);

    if (proxyHandler) {
      expect(proxyHandler).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: non-demo mode (proxy path preserved)
// ---------------------------------------------------------------------------

describe('GET /api/brainstorms/[id]/events — non-demo mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns proxy response when NEXT_PUBLIC_DEMO_MODE is false', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
    const [req, ctx] = makeRequest(DEMO_ROOM_ID);
    const res = await GET(req, ctx);
    const text = await res.text();
    expect(text).toBe('proxy');
  });
});
