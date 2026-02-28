import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getConfigTree } from '@/lib/services/config-service';
import { BadRequestError } from '@/lib/errors';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope');
  const projectPath = url.searchParams.get('projectPath');

  if (scope === 'global') {
    const data = await getConfigTree('global');
    return NextResponse.json({ data });
  }

  if (projectPath) {
    const data = await getConfigTree({ projectPath });
    return NextResponse.json({ data });
  }

  throw new BadRequestError(
    'Provide either scope=global or projectPath=<absolute-path> as a query parameter',
  );
});
