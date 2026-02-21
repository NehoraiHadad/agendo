import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { listTaskEvents, createTaskEvent } from '@/lib/services/task-event-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const events = await listTaskEvents(id);
    return NextResponse.json({ data: events });
  },
);

const ALLOWED_EVENT_TYPES = ['agent_note', 'status_change', 'comment'] as const;

/**
 * POST /api/tasks/[id]/events
 *
 * Allows agents (and other callers) to append a structured event to a task's
 * event log. The actorType is always 'agent' for this endpoint — if user or
 * system events are needed in the future, separate endpoints should be used.
 *
 * Body: { eventType: 'agent_note' | 'status_change' | 'comment', payload?: object }
 */
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = await req.json() as { eventType?: unknown; payload?: unknown };

    if (
      !body.eventType ||
      !ALLOWED_EVENT_TYPES.includes(body.eventType as (typeof ALLOWED_EVENT_TYPES)[number])
    ) {
      return NextResponse.json(
        { error: { message: `eventType must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}` } },
        { status: 400 },
      );
    }

    const event = await createTaskEvent({
      taskId: id,
      actorType: 'agent',
      eventType: body.eventType as string,
      payload: (body.payload as Record<string, unknown>) ?? {},
    });

    return NextResponse.json({ data: event }, { status: 201 });
  },
);
