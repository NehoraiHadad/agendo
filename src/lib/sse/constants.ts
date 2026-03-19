/**
 * Shared SSE (Server-Sent Events) response headers.
 *
 * Used by all SSE route handlers to ensure consistent behaviour
 * across Next.js API routes and the Worker HTTP server.
 *
 * - `X-Accel-Buffering: no` prevents nginx from buffering the stream.
 * - `Cache-Control: no-cache, no-transform` prevents CDN / browser caching.
 */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;
