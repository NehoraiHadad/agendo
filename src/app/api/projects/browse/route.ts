import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { browseProjectDirectories } from '@/lib/services/project-path-service';
import { listProjects } from '@/lib/services/project-service';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const requestedPath = url.searchParams.get('path') ?? undefined;

  const [browseData, existingProjects] = await Promise.all([
    browseProjectDirectories(requestedPath),
    listProjects(),
  ]);

  const registeredPaths = new Set(existingProjects.map((project) => project.rootPath));

  return NextResponse.json({
    data: {
      ...browseData,
      currentPathRegistered:
        browseData.currentPath !== null && registeredPaths.has(browseData.currentPath),
      entries: browseData.entries.map((entry) => ({
        ...entry,
        isRegistered: registeredPaths.has(entry.path),
      })),
    },
  });
});
