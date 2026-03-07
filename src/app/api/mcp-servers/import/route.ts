import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { importFromInstalledPlugins } from '@/lib/services/mcp-server-service';

export const POST = withErrorBoundary(async () => {
  const result = await importFromInstalledPlugins();
  return NextResponse.json(result);
});
