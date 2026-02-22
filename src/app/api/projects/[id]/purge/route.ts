// DELETE /api/projects/:id/purge?withTasks=true
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { purgeProject } from '@/lib/services/project-service';

export const DELETE = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    const withTasks = new URL(req.url).searchParams.get('withTasks') === 'true';
    await purgeProject(id, { withTasks });
    return new NextResponse(null, { status: 204 });
  },
);
