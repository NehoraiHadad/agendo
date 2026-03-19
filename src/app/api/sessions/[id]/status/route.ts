import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID, requireFound } from '@/lib/api-handler';
import { getSessionStatus } from '@/lib/services/session-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const result = await getSessionStatus(id);
    requireFound(result, 'Session', id);
    return NextResponse.json(result);
  },
);
