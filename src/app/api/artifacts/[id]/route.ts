import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { NotFoundError } from '@/lib/errors';
import { getArtifact } from '@/lib/services/artifact-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Artifact');
    const artifact = await getArtifact(id);
    if (!artifact) throw new NotFoundError('Artifact not found');
    return NextResponse.json({ data: artifact });
  },
);
