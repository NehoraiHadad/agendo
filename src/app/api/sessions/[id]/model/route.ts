import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { BadRequestError, NotFoundError } from '@/lib/errors';

/**
 * PATCH /api/sessions/[id]/model
 *
 * Switch the AI model of a live session. If the session has a live process
 * (status=active or awaiting_input), a set-model control message is published
 * via PG NOTIFY so the worker can send a control_request to the agent CLI.
 *
 * For idle/ended sessions the DB update takes effect on the next cold resume.
 */
export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const body = (await req.json()) as { model?: unknown };
    if (!body.model || typeof body.model !== 'string') {
      throw new BadRequestError('model must be a non-empty string');
    }

    const model = body.model;

    const [updated] = await db
      .update(sessions)
      .set({ model })
      .where(eq(sessions.id, id))
      .returning({
        id: sessions.id,
        status: sessions.status,
        model: sessions.model,
      });

    if (!updated) throw new NotFoundError('Session', id);

    // Notify worker if process is live — it will send set_model control_request.
    if (['active', 'awaiting_input'].includes(updated.status)) {
      await publish(channelName('agendo_control', id), { type: 'set-model', model });
    }

    return NextResponse.json({ data: updated });
  },
);
