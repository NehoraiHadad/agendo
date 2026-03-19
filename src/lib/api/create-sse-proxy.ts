import { NextRequest } from 'next/server';
import { assertUUID } from '@/lib/api-handler';
import { SSE_HEADERS } from '@/lib/sse/constants';

const WORKER_HTTP_PORT = process.env.WORKER_HTTP_PORT ?? '4102';

/**
 * Creates a GET handler that proxies an SSE stream from the Worker HTTP server.
 *
 * The Worker serves SSE on port 4102; this factory builds a Next.js route
 * handler that fetches from the Worker and pipes the response body directly
 * to the browser — zero buffering.
 *
 * @param workerPathBuilder - builds the Worker URL path from the resource id
 *   e.g. `(id) => \`/sessions/${id}/events\``
 * @param resourceLabel - label used in assertUUID error messages (e.g. 'Session')
 */
export function createSSEProxyHandler(
  workerPathBuilder: (id: string) => string,
  resourceLabel: string,
) {
  return async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    const { id } = await params;
    try {
      assertUUID(id, resourceLabel);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const lastEventId =
      req.headers.get('last-event-id') ?? req.nextUrl.searchParams.get('lastEventId') ?? '';

    const workerUrl = `http://localhost:${WORKER_HTTP_PORT}${workerPathBuilder(id)}${
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
        headers: SSE_HEADERS,
      });
    } catch {
      return new Response('Worker unavailable', { status: 502 });
    }
  };
}
