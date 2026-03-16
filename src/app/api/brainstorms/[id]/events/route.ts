import { NextRequest } from 'next/server';
import { assertUUID } from '@/lib/api-handler';

const WORKER_HTTP_PORT = process.env.WORKER_HTTP_PORT ?? '4102';

/**
 * GET /api/brainstorms/:id/events
 *
 * Streaming proxy to Worker SSE for brainstorm events.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    assertUUID(id, 'Brainstorm');
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const lastEventId =
    req.headers.get('last-event-id') ?? req.nextUrl.searchParams.get('lastEventId') ?? '';

  const workerUrl = `http://localhost:${WORKER_HTTP_PORT}/brainstorms/${id}/events${
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
