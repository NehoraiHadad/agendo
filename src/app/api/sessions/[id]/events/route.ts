import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { sendSessionEvent } from '@/lib/realtime/worker-client';
import type { AgendoEventPayload } from '@/lib/realtime/events';

/**
 * POST /api/sessions/:id/events
 *
 * Accepts an event payload and forwards it to the worker via HTTP so the
 * worker's in-memory SSE listeners receive it.
 *
 * GET /api/sessions/:id/events is intentionally removed — clients should use
 * /api/sessions/:id/live which is a Next.js rewrite to the Worker SSE endpoint.
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
