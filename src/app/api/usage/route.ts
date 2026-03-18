import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { fetchAllUsage } from '@/lib/services/usage-service';

export const GET = withErrorBoundary(async () => {
  const results = await fetchAllUsage();
  return NextResponse.json({ data: results });
});
