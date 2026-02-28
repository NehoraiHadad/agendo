import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSnapshot, deleteSnapshot } from '@/lib/services/snapshot-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'ContextSnapshot');

    const snapshot = await getSnapshot(id);
    return NextResponse.json({ data: snapshot });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'ContextSnapshot');

    await deleteSnapshot(id);
    return NextResponse.json({ data: { id } });
  },
);
