import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { readConfigFile } from '@/lib/services/config-service';
import { BadRequestError } from '@/lib/errors';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const filePath = url.searchParams.get('path');

  if (!filePath) {
    throw new BadRequestError('Provide the file path via the path= query parameter');
  }

  const data = await readConfigFile(filePath);
  return NextResponse.json({ data });
});
