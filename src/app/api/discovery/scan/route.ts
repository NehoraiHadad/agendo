import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { runDiscovery } from '@/lib/discovery';
import { getExistingSlugs } from '@/lib/services/agent-service';

export const POST = withErrorBoundary(async () => {
  const existingSlugs = await getExistingSlugs();
  const tools = await runDiscovery(undefined, existingSlugs);
  return NextResponse.json({ data: tools });
});
