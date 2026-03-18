import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getAllProviderStatuses } from '@/lib/services/provider-status-service';

export const GET = withErrorBoundary(async () => {
  const providers = getAllProviderStatuses();
  return NextResponse.json({ data: providers });
});
