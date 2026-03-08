import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { listPlugins } from '@/lib/services/plugin-service';

export const GET = withErrorBoundary(async () => {
  const plugins = await listPlugins();
  return NextResponse.json({ data: plugins });
});
