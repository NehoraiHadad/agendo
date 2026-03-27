/**
 * Build a URL for direct browser → Worker SSE connections.
 *
 * SSE streams are long-lived (hours). The Next.js dev server has an internal
 * ~70s timeout on streaming route handler responses that kills the proxy
 * connection. To avoid this, the browser connects directly to the Worker's
 * HTTP server on the same host, different port.
 *
 * In production the Worker port is on the same machine, accessible via the
 * same hostname. The port is exposed as NEXT_PUBLIC_WORKER_HTTP_PORT at
 * build/dev time via next.config.ts.
 *
 * @param path - Worker path, e.g. `/sessions/:id/events`
 * @returns Full URL like `http://hostname:4102/sessions/:id/events`
 */
export function buildWorkerSSEUrl(path: string): string {
  const port = process.env.NEXT_PUBLIC_WORKER_HTTP_PORT ?? '4102';

  if (typeof window === 'undefined') {
    // Server-side: shouldn't be called, but return localhost as fallback
    return `http://localhost:${port}${path}`;
  }

  // Browser: use the same hostname as the current page, different port
  return `${window.location.protocol}//${window.location.hostname}:${port}${path}`;
}
