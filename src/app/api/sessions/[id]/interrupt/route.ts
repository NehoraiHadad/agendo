import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { interruptSession } from '@/lib/services/session-service';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    await interruptSession(id);

    return NextResponse.json({ data: { interrupted: true } }, { status: 202 });
  },
);
