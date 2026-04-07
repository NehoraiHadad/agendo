import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { ValidationError } from '@/lib/errors';
import { getProjectPathStatus } from '@/lib/services/project-path-service';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get('path');

  if (!rawPath) {
    throw new ValidationError('Missing required query parameter: path');
  }

  if (!rawPath.startsWith('/')) {
    return NextResponse.json({
      data: { status: 'denied' as const, reason: 'Path must be absolute' },
    });
  }

  const status = await getProjectPathStatus(rawPath);
  return NextResponse.json({ data: status });
});
