import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getDashboardStats, getActiveExecutionsList } from '@/lib/services/dashboard-service';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const view = url.searchParams.get('view');

  if (view === 'active-executions') {
    const data = await getActiveExecutionsList();
    return NextResponse.json({ data });
  }

  const stats = await getDashboardStats();
  return NextResponse.json({ data: stats });
});
