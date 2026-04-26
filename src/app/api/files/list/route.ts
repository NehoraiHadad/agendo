import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { listDirectory } from '@/lib/services/file-viewer-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/files/list?dir=<absolute path>
 *
 * Returns a JSON {@link FileViewerResult} for the requested directory, or — when
 * `dir` is omitted — a "root picker" payload listing the configured allowed roots.
 *
 * Errors:
 *  - 403 FORBIDDEN if `dir` is outside the allowed roots.
 *  - 404 NOT_FOUND if the directory does not exist.
 *  - 422 VALIDATION_ERROR if `dir` resolves to a file instead of a directory.
 */
export const GET = withErrorBoundary(async (req: NextRequest) => {
  const dir = req.nextUrl.searchParams.get('dir') ?? undefined;
  const data = await listDirectory(dir);
  return NextResponse.json({ data });
});
