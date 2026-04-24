import { NextRequest } from 'next/server';
import { createSSEProxyHandler } from '@/lib/api/create-sse-proxy';
import { isDemoMode } from '@/lib/demo/flag';
import { replayEventsAsSSE } from '@/lib/demo/sse/replay';
import { DEMO_BRAINSTORM_ROOMS } from '@/lib/demo/fixtures/brainstorms';
import { SSE_HEADERS } from '@/lib/sse/constants';
import type { ReplayableEvent } from '@/lib/demo/sse/replay';

/**
 * SSE streams are long-lived. Set to the Vercel hobby-plan maximum (300s).
 * In demo mode, the replay finishes in seconds; in production this is a proxy.
 */
export const maxDuration = 300;

/** Proxy handler used in non-demo mode. */
const proxyGET = createSSEProxyHandler((id) => `/brainstorms/${id}/events`, 'Brainstorm');

/**
 * GET /api/brainstorms/:id/events
 *
 * In demo mode: replays pre-recorded events from DEMO_BRAINSTORM_ROOMS.
 * In production: streaming proxy to Worker SSE (port 4102).
 *
 * Brainstorm event payload reconstruction:
 *   The fixture stores events with `payload: BrainstormEventPayload` which
 *   already contains the `type` discriminant. The frontend hooks expect each
 *   SSE data payload to include `{ id, roomId, ts }` envelope fields.
 *   We merge them in here: `{ id: seq, roomId, ts: baseTs + atMs, ...payload }`.
 *   Using `baseTs + atMs` (captured once at stream start) gives each event a
 *   meaningful, incrementing timestamp rather than collapsing them to Date.now().
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  if (isDemoMode()) {
    const rawEvents = DEMO_BRAINSTORM_ROOMS[id];
    if (!rawEvents) {
      return new Response('Unknown demo brainstorm room', { status: 404 });
    }

    // Capture a stable base timestamp so relative times are consistent
    const baseTs = Date.now();

    // Reconstruct the full envelope expected by the frontend.
    // Payload fields come last so the payload's own `type` discriminant wins
    // over the envelope fields we inject.
    const events: ReplayableEvent[] = rawEvents.map((e, i) => ({
      atMs: e.atMs,
      type: e.type,
      payload: {
        id: i + 1, // BrainstormEventBase.id is number
        roomId: id,
        ts: baseTs + e.atMs,
        // Spread payload last — its `type` field takes precedence
        ...(e.payload as Record<string, unknown>),
      },
    }));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = replayEventsAsSSE(events, controller, {
          signal: req.signal,
          speed: 1.0,
          // Brainstorm clients consume SSE via EventSource.onmessage, which
          // only fires for unnamed frames.
          emitEventName: false,
        });
        req.signal.addEventListener('abort', cleanup, { once: true });
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  return proxyGET(req, context);
}
