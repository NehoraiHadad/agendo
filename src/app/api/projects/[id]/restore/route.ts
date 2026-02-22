import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { restoreProject } from '@/lib/services/project-service';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    const project = await restoreProject(id);
    return NextResponse.json({ data: project });
  },
);
