import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getDashboardStats } from '@/lib/services/dashboard-service';

export const GET = withErrorBoundary(async () => {
  const stats = await getDashboardStats();
  return NextResponse.json({ data: stats });
});
