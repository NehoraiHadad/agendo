import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/errors';
import type { AgendoControl } from '@/lib/realtime/events';

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = await req.json();
    const { message, image } = body as {
      message: unknown;
      image?: { mimeType: string; data: string };
    };
    if (!message || typeof message !== 'string') {
      throw new ValidationError('message is required and must be a string');
    }
    const [execution] = await db.select().from(executions).where(eq(executions.id, id)).limit(1);
    if (!execution) throw new NotFoundError('Execution', id);

    // Session-based execution: forward message via PG NOTIFY to the live process.
    if (execution.sessionId) {
      const control: AgendoControl = {
        type: 'message',
        text: message,
        ...(image && { image }),
      };
      await publish(channelName('agendo_control', execution.sessionId), control);
      return NextResponse.json({ data: { sent: true } });
    }

    // Legacy template-mode execution: execution must be running.
    if (execution.status !== 'running') {
      throw new ConflictError(
        `Cannot send message to execution in "${execution.status}" status. Must be "running".`,
      );
    }

    // Legacy path no longer accepts messages — template-mode adapters do not
    // support interactive stdin. Return a clear error to avoid silent data loss.
    throw new ConflictError(
      'This execution does not support interactive messages. Use a session-based execution.',
    );
  },
);
