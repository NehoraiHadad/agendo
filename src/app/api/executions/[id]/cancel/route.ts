import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { cancelExecution } from '@/lib/services/execution-service';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const cancelled = await cancelExecution(id);
    return NextResponse.json({ data: cancelled }, { status: 202 });
  },
);
