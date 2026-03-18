import { withErrorBoundary } from '@/lib/api-handler';
import { checkForUpdates } from '@/lib/services/version-service';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/version
 * Returns current version and update availability (uses cache).
 */
export const GET = withErrorBoundary(async (_req: NextRequest) => {
  const result = await checkForUpdates();
  return NextResponse.json(result);
});

/**
 * POST /api/version
 * Forces a fresh version check (bypasses cache).
 */
export const POST = withErrorBoundary(async (_req: NextRequest) => {
  const result = await checkForUpdates({ forceRefresh: true });
  return NextResponse.json(result);
});
