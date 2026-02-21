import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getExecutionById } from '@/lib/services/execution-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Execution');
    const execution = await getExecutionById(id);
    return NextResponse.json({ data: execution });
  },
);
