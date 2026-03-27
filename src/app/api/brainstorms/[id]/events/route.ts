import { createSSEProxyHandler } from '@/lib/api/create-sse-proxy';

/** SSE streams are long-lived — disable the default route handler timeout. */
export const maxDuration = 0;

/**
 * GET /api/brainstorms/:id/events
 *
 * Streaming proxy to Worker SSE for brainstorm events.
 */
export const GET = createSSEProxyHandler((id) => `/brainstorms/${id}/events`, 'Brainstorm');
