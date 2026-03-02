import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { forkSession } from '@/lib/services/session-service';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const fork = await forkSession(id);

    return NextResponse.json({ data: { id: fork.id } }, { status: 201 });
  },
);
