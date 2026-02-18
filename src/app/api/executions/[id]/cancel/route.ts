import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { cancelExecution } from '@/lib/services/execution-service';
import { db } from '@/lib/db';
import { executions, sessions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { publish, channelName } from '@/lib/realtime/pg-notify';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;

    // Check if this execution belongs to a session.
    const [executionMeta] = await db
      .select({ sessionId: executions.sessionId })
      .from(executions)
      .where(eq(executions.id, id))
      .limit(1);

    if (executionMeta?.sessionId) {
      // Session-based execution: transition the session to 'ended' and notify
      // the live process via PG NOTIFY so it can shut down gracefully.
      const updated = await db
        .update(sessions)
        .set({ status: 'ended', endedAt: new Date() })
        .where(
          and(
            eq(sessions.id, executionMeta.sessionId),
            inArray(sessions.status, ['active', 'awaiting_input']),
          ),
        )
        .returning({ id: sessions.id });

      if (updated.length > 0) {
        await publish(
          channelName('agendo_control', executionMeta.sessionId),
          { type: 'cancel' },
        );
      }

      return NextResponse.json({ data: { cancelled: true } }, { status: 202 });
    }

    // Legacy path: mark execution as 'cancelling' and let the worker SIGTERM.
    const cancelled = await cancelExecution(id);
    return NextResponse.json({ data: cancelled }, { status: 202 });
  },
);
