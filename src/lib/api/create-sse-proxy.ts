import * as http from 'node:http';
import { NextRequest } from 'next/server';
import { assertUUID } from '@/lib/api-handler';
import { SSE_HEADERS } from '@/lib/sse/constants';

const WORKER_HTTP_PORT = process.env.WORKER_HTTP_PORT ?? '4102';

/**
 * Creates a GET handler that proxies an SSE stream from the Worker HTTP server.
 *
 * Uses `node:http.request` instead of `fetch()` because:
 *   - Node.js fetch (undici) has an internal body timeout (~300s) that cannot
 *     be disabled via the standard fetch API. `bodyTimeout` is an undici-specific
 *     option that `fetch()` silently ignores.
 *   - SSE streams are indefinitely long-lived. Any body timeout will kill the
 *     connection, causing the browser to reconnect and replay full history.
 *   - `node:http` has no body timeout at all — the socket stays open as long
 *     as both ends are alive. Combined with the worker's 15s keepalive heartbeat,
 *     this ensures the connection never drops due to idle timeouts.
 *
 * @param workerPathBuilder - builds the Worker URL path from the resource id
 * @param resourceLabel - label used in assertUUID error messages
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

    const path = `${workerPathBuilder(id)}${lastEventId ? `?lastEventId=${lastEventId}` : ''}`;

    // Pipe the worker's SSE stream to the browser via a ReadableStream.
    // node:http.request has no body timeout — the connection stays alive
    // as long as data flows (including heartbeat comments every 15s).
    const stream = new ReadableStream({
      start(controller) {
        const proxyReq = http.request(
          {
            hostname: 'localhost',
            port: Number(WORKER_HTTP_PORT),
            path,
            method: 'GET',
            headers: {
              Accept: 'text/event-stream',
              ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
            },
          },
          (proxyRes) => {
            if (proxyRes.statusCode !== 200) {
              controller.close();
              return;
            }

            proxyRes.on('data', (chunk: Buffer) => {
              try {
                controller.enqueue(chunk);
              } catch {
                // Stream closed by browser — ignore
              }
            });

            proxyRes.on('end', () => {
              try {
                controller.close();
              } catch {
                // Already closed
              }
            });

            proxyRes.on('error', () => {
              try {
                controller.close();
              } catch {
                // Already closed
              }
            });
          },
        );

        proxyReq.on('error', () => {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        });

        // When the browser disconnects, abort the upstream request so the
        // worker cleans up its in-memory SSE listener immediately.
        req.signal.addEventListener('abort', () => {
          proxyReq.destroy();
        });

        proxyReq.end();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: SSE_HEADERS,
    });
  };
}
