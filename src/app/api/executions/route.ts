import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';

export const GET = withErrorBoundary(async () => {
  return NextResponse.json({ data: [], meta: { total: 0, page: 1, pageSize: 50 } });
});

export const POST = withErrorBoundary(async () => {
  return NextResponse.json({ data: {} }, { status: 501 });
});
