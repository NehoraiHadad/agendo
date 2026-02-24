import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { BadRequestError, NotFoundError } from '@/lib/errors';

const VALID_MODES = ['default', 'bypassPermissions', 'acceptEdits', 'plan', 'dontAsk'] as const;
type PermissionMode = (typeof VALID_MODES)[number];

/**
 * PATCH /api/sessions/[id]/mode
 *
 * Change the permission mode of a session. If the session has a live process
 * (status=active or awaiting_input), a set-permission-mode control message is
 * published via PG NOTIFY so the worker can gracefully terminate and restart
 * the agent with the new --permission-mode flag.
 *
 * For idle/ended sessions the DB update takes effect on the next cold resume.
 */
export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const body = (await req.json()) as { mode?: unknown };
    if (!body.mode || !VALID_MODES.includes(body.mode as PermissionMode)) {
      throw new BadRequestError(
        `Invalid permission mode. Must be one of: ${VALID_MODES.join(', ')}`,
      );
    }

    const mode = body.mode as PermissionMode;

    const [updated] = await db
      .update(sessions)
      .set({ permissionMode: mode })
      .where(eq(sessions.id, id))
      .returning({
        id: sessions.id,
        status: sessions.status,
        permissionMode: sessions.permissionMode,
      });

    if (!updated) throw new NotFoundError('Session', id);

    // Notify worker if process is live — it will terminate and restart with new mode.
    if (['active', 'awaiting_input'].includes(updated.status)) {
      await publish(channelName('agendo_control', id), { type: 'set-permission-mode', mode });
    }

    return NextResponse.json({ data: updated });
  },
);
