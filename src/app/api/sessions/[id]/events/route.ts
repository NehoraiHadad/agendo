import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { sendSessionEvent } from '@/lib/realtime/worker-client';
import { createSSEProxyHandler } from '@/lib/api/create-sse-proxy';
import type { AgendoEventPayload } from '@/lib/realtime/events';

/**
 * SSE streams are long-lived — disable the default route handler timeout.
 * Without this, Next.js terminates the response after ~60-90s in dev mode.
 */
export const maxDuration = 0;

/**
 * GET /api/sessions/:id/events
 *
 * Streaming proxy to Worker SSE. The Worker serves SSE on port 4102;
 * this route fetches from Worker and pipes the response body directly
 * to the browser as a ReadableStream — zero buffering.
 *
 * Why not use next.config.ts rewrites? Because Next.js rewrites buffer
 * the upstream response, which breaks SSE real-time delivery.
 */
export const GET = createSSEProxyHandler((id) => `/sessions/${id}/events`, 'Session');

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
