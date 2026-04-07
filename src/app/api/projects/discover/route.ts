import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { discoverProjectDirectories } from '@/lib/services/project-path-service';
import { listProjects } from '@/lib/services/project-service';

export const GET = withErrorBoundary(async (_req: NextRequest) => {
  const existingProjects = await listProjects();
  const registeredPaths = new Set(existingProjects.map((p) => p.rootPath));
  const discovered = await discoverProjectDirectories();

  return NextResponse.json({
    data: discovered.filter((project) => !registeredPaths.has(project.path)),
  });
});
