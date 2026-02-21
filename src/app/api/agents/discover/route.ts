import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { runDiscovery } from '@/lib/discovery';
import { getExistingSlugs, getExistingBinaryPaths } from '@/lib/services/agent-service';

export const POST = withErrorBoundary(async (_req: NextRequest) => {
  const [existingSlugs, existingBinaryPaths] = await Promise.all([
    getExistingSlugs(),
    getExistingBinaryPaths(),
  ]);
  const tools = await runDiscovery(undefined, existingSlugs, existingBinaryPaths);
  return NextResponse.json({ data: tools });
});
