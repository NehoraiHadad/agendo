// DELETE /api/projects/:id/purge?withTasks=true&withDirectory=true
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { purgeProject } from '@/lib/services/project-service';

export const DELETE = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    const url = new URL(req.url);
    const withTasks = url.searchParams.get('withTasks') === 'true';
    const withDirectory = url.searchParams.get('withDirectory') === 'true';
    await purgeProject(id, { withTasks, withDirectory });
    return new NextResponse(null, { status: 204 });
  },
);
