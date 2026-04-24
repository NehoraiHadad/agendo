import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { sendSessionEvent } from '@/lib/realtime/worker-client';
import { createSSEProxyHandler } from '@/lib/api/create-sse-proxy';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { isDemoMode } from '@/lib/demo/flag';
import { replayEventsAsSSE } from '@/lib/demo/sse/replay';
import { DEMO_SESSION_EVENTS } from '@/lib/demo/fixtures/sessions';
import { SSE_HEADERS } from '@/lib/sse/constants';

/**
 * SSE streams are long-lived. Set to the Vercel hobby-plan maximum (300s).
 * In demo mode, the replay finishes in seconds; in production this is a proxy.
 * Without this export, Next.js terminates the response after ~60-90s in dev mode.
 */
export const maxDuration = 300;

/** Proxy handler used in non-demo mode. */
const proxyGET = createSSEProxyHandler((id) => `/sessions/${id}/events`, 'Session');

/**
 * GET /api/sessions/:id/events
 *
 * In demo mode: replays pre-recorded events from DEMO_SESSION_EVENTS.
 * In production: streaming proxy to Worker SSE (port 4102).
 *
 * Why not use next.config.ts rewrites? Because Next.js rewrites buffer
 * the upstream response, which breaks SSE real-time delivery.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  if (isDemoMode()) {
    const rawEvents = DEMO_SESSION_EVENTS[id];
    if (!rawEvents) {
      return new Response('Unknown demo session', { status: 404 });
    }

    // Reconstruct the full AgendoEvent envelope the frontend expects:
    //   { id: seq, sessionId, ts, ...payload }
    // The worker's SSE producer emits unnamed frames (`id: N\ndata: ...\n\n`);
    // matching that format lets native EventSource.onmessage fire for each event.
    const baseTs = Date.now();
    const events = rawEvents.map((e, i) => ({
      atMs: e.atMs,
      type: e.type,
      payload: {
        id: i + 1,
        sessionId: id,
        ts: baseTs + e.atMs,
        ...(e.payload as Record<string, unknown>),
      },
    }));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = replayEventsAsSSE(events, controller, {
          signal: req.signal,
          speed: 1.0,
          emitEventName: false,
        });
        req.signal.addEventListener('abort', cleanup, { once: true });
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  return proxyGET(req, context);
}

/**
 * POST /api/sessions/:id/events
 *
 * Accepts an event payload and forwards it to the worker via HTTP so the
 * worker's in-memory SSE listeners receive it.
 */
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    // Demo mode: acknowledge silently — no Worker exists to forward to.
    if (isDemoMode()) {
      return new NextResponse(null, { status: 204 });
    }

    // Verify session exists and is not ended — reject stale POSTs early
    const session = await getSession(id);
    if (session.status === 'ended') {
      return new NextResponse(null, { status: 410 });
    }

    const body = (await req.json()) as Record<string, unknown>;

    await sendSessionEvent(id, body as AgendoEventPayload);

    return new NextResponse(null, { status: 204 });
  },
);
