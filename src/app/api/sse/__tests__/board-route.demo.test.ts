/**
 * Demo mode tests for:
 *   GET /api/sse/board — SSE replay from generateBoardUpdates()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoist DB mock so it runs before any imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/services/task-service', () => ({
  listTasksBoardItems: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Route import (after mocks)
// ---------------------------------------------------------------------------

import { GET } from '../board/route';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SSE_CONTENT_TYPE = 'text/event-stream';
const NO_CACHE = 'no-cache, no-transform';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Tests: GET /api/sse/board (demo mode)
// ---------------------------------------------------------------------------

describe('GET /api/sse/board — demo mode', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns SSE headers', async () => {
    const req = new NextRequest('http://localhost/api/sse/board');
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
    expect(res.headers.get('cache-control')).toBe(NO_CACHE);
    expect(res.headers.get('connection')).toBe('keep-alive');
    if (res.body) res.body.cancel().catch(() => undefined);
  });

  it('first frame is a snapshot event with tasks array', async () => {
    vi.useFakeTimers();

    const req = new NextRequest('http://localhost/api/sse/board');
    const res = await GET(req);
    expect(res.body).not.toBeNull();

    // Advance past snapshot (atMs=0 → fires immediately)
    vi.advanceTimersByTime(500);

    const frames = await readFirstFrames(res.body!, 1);

    const eventFrames = frames.filter((f) => f.startsWith('id:'));
    expect(eventFrames.length).toBeGreaterThanOrEqual(1);

    const firstFrame = eventFrames[0]!;
    expect(firstFrame).toContain('event: snapshot');

    // Parse payload from data: line
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

  it('emits task_updated events after snapshot', async () => {
    vi.useFakeTimers();

    const req = new NextRequest('http://localhost/api/sse/board');
    const res = await GET(req);
    expect(res.body).not.toBeNull();

    // Advance past snapshot (0ms) and first update (8000ms default intervalMs)
    vi.advanceTimersByTime(10_000);

    const frames = await readFirstFrames(res.body!, 2);
    const eventFrames = frames.filter((f) => f.startsWith('id:'));
    expect(eventFrames.length).toBeGreaterThanOrEqual(2);

    // Second frame should be task_updated
    const secondFrame = eventFrames[1]!;
    expect(secondFrame).toContain('event: task_updated');

    const dataLine = secondFrame.split('\n').find((l) => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice('data:'.length).trim()) as {
      type: string;
      task: unknown;
    };
    expect(payload.type).toBe('task_updated');
    expect(payload.task).toBeDefined();

    vi.useRealTimers();
  });

  it('does not query the database in demo mode', async () => {
    const { listTasksBoardItems } = await import('@/lib/services/task-service');
    const mockList = vi.mocked(listTasksBoardItems);
    const callsBefore = mockList.mock.calls.length;

    const req = new NextRequest('http://localhost/api/sse/board');
    const res = await GET(req);
    if (res.body) res.body.cancel().catch(() => undefined);

    expect(mockList.mock.calls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Tests: non-demo mode (real polling path)
// ---------------------------------------------------------------------------

describe('GET /api/sse/board — non-demo mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('calls listTasksBoardItems for initial snapshot when not in demo mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');

    const { listTasksBoardItems } = await import('@/lib/services/task-service');
    const mockList = vi.mocked(listTasksBoardItems);
    mockList.mockResolvedValue([]);

    const ac = new AbortController();
    const req = new NextRequest('http://localhost/api/sse/board', {
      signal: ac.signal,
    });
    const res = await GET(req);
    // Cancel stream to stop poll timers
    if (res.body) res.body.cancel().catch(() => undefined);
    ac.abort();

    // DB was called for the snapshot
    expect(mockList).toHaveBeenCalled();
  });
});
