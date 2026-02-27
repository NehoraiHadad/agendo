import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { discoverCliSessions } from '@/lib/services/cli-import';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const hideImported = req.nextUrl.searchParams.get('hideImported') !== 'false';
  const entries = await discoverCliSessions({ hideImported });
  return NextResponse.json({ data: entries });
});
