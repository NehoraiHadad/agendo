import { createSSEProxyHandler } from '@/lib/api/create-sse-proxy';

/**
 * GET /api/brainstorms/:id/events
 *
 * Streaming proxy to Worker SSE for brainstorm events.
 */
export const GET = createSSEProxyHandler((id) => `/brainstorms/${id}/events`, 'Brainstorm');
