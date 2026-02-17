import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { listTaskEvents } from '@/lib/services/task-event-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const events = await listTaskEvents(id);
    return NextResponse.json({ data: events });
  },
);
