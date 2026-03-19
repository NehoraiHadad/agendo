import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { BadRequestError } from '@/lib/errors';
import { getPlanVersion } from '@/lib/services/plan-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id, version } = await params;
    assertUUID(id, 'Plan');

    const versionNum = parseInt(version, 10);
    if (isNaN(versionNum) || versionNum < 1) {
      throw new BadRequestError('Invalid version number', { version });
    }

    const planVersion = await getPlanVersion(id, versionNum);
    return NextResponse.json({ data: planVersion });
  },
);
