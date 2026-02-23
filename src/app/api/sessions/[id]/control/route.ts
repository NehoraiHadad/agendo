import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { BadRequestError } from '@/lib/errors';
import type { AgendoControl } from '@/lib/realtime/events';

/**
 * POST /api/sessions/[id]/control
 *
 * Generic control channel endpoint. Publishes any AgendoControl payload to
 * the per-session PG NOTIFY channel. The session-process listener handles it.
 *
 * Currently used for: tool-approval decisions (allow/deny/allow-session).
 * More specific control actions use dedicated routes (message, cancel).
 */
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = (await req.json()) as AgendoControl;

    // Only allow types that require simple PG NOTIFY relay (not the ones with
    // dedicated routes that do extra DB work, like 'message' and 'cancel').
    const allowedTypes = new Set(['tool-approval', 'tool-result']);
    if (!allowedTypes.has(body.type)) {
      throw new BadRequestError(`Control type '${body.type}' is not handled by this endpoint`);
    }

    await publish(channelName('agendo_control', id), body);

    return NextResponse.json({ data: { delivered: true } }, { status: 202 });
  },
);
