import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { ConflictError } from '@/lib/errors';
import type { AgendoControl } from '@/lib/realtime/events';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;

    const result = await db
      .update(sessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(
        and(
          eq(sessions.id, id),
          inArray(sessions.status, ['active', 'awaiting_input']),
        ),
      )
      .returning({ id: sessions.id });

    if (result.length === 0) {
      throw new ConflictError('Session not active or already ended');
    }

    const control: AgendoControl = { type: 'cancel' };
    await publish(channelName('agendo_control', id), control);

    return NextResponse.json({ data: { cancelled: true } }, { status: 202 });
  },
);
