import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { ConflictError } from '@/lib/errors';
import type { AgendoControl } from '@/lib/realtime/events';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;

    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.status, 'active')))
      .limit(1);

    if (!session) {
      throw new ConflictError('Session not active');
    }

    const control: AgendoControl = { type: 'interrupt' };
    await publish(channelName('agendo_control', id), control);

    return NextResponse.json({ data: { interrupted: true } }, { status: 202 });
  },
);
