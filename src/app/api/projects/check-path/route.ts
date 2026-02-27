import { NextRequest, NextResponse } from 'next/server';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { withErrorBoundary } from '@/lib/api-handler';
import { allowedWorkingDirs } from '@/lib/config';
import { ValidationError } from '@/lib/errors';

type PathStatus = 'exists' | 'creatable' | 'denied';

function isUnderAllowedDir(resolved: string): boolean {
  return allowedWorkingDirs.some(
    (allowed) => resolved === allowed || resolved.startsWith(allowed + '/'),
  );
}

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get('path');

  if (!rawPath) {
    throw new ValidationError('Missing required query parameter: path');
  }

  if (!rawPath.startsWith('/')) {
    return NextResponse.json({
      data: { status: 'denied' as PathStatus, reason: 'Path must be absolute' },
    });
  }

  const normalized = resolve(rawPath);

  try {
    const stats = await stat(normalized);
    if (stats.isDirectory()) {
      return NextResponse.json({ data: { status: 'exists' as PathStatus } });
    }
    return NextResponse.json({
      data: { status: 'denied' as PathStatus, reason: 'Path is a file, not a directory' },
    });
  } catch {
    // Path doesn't exist — check if it's under an allowed dir
    if (isUnderAllowedDir(normalized)) {
      return NextResponse.json({ data: { status: 'creatable' as PathStatus } });
    }
    return NextResponse.json({
      data: {
        status: 'denied' as PathStatus,
        reason: `Path not under allowed directories: ${allowedWorkingDirs.join(', ')}`,
      },
    });
  }
});
