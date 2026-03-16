import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { sendSessionEvent } from '@/lib/realtime/worker-client';
import type { AgendoEventPayload } from '@/lib/realtime/events';

const WORKER_HTTP_PORT = process.env.WORKER_HTTP_PORT ?? '4102';

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
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    assertUUID(id, 'Session');
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const lastEventId =
    req.headers.get('last-event-id') ?? req.nextUrl.searchParams.get('lastEventId') ?? '';

  const workerUrl = `http://localhost:${WORKER_HTTP_PORT}/sessions/${id}/events${
    lastEventId ? `?lastEventId=${lastEventId}` : ''
  }`;

  try {
    const upstream = await fetch(workerUrl, {
      headers: {
        Accept: 'text/event-stream',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      // @ts-expect-error -- Node.js fetch supports duplex for streaming
      duplex: 'half',
    });

    if (!upstream.ok || !upstream.body) {
      return new Response(upstream.statusText, { status: upstream.status });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch {
    return new Response('Worker unavailable', { status: 502 });
  }
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

    // Verify session exists (throws NotFoundError if not)
    await getSession(id);

    const body = (await req.json()) as Record<string, unknown>;

    await sendSessionEvent(id, body as AgendoEventPayload);

    return new NextResponse(null, { status: 204 });
  },
);
