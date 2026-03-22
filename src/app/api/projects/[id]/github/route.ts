import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getGitHubSyncStatus } from '@/lib/services/github-sync-service';
import { updateProject } from '@/lib/services/project-service';

/**
 * GET /api/projects/:id/github
 * Returns GitHub sync status for a project.
 */
export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    const status = await getGitHubSyncStatus(id);
    if (!status) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Project not found' } },
        { status: 404 },
      );
    }
    return NextResponse.json({ data: status });
  },
);

const patchSchema = z.object({
  /** Connect to a specific repo (format: "owner/repo") or null to disconnect. */
  githubRepo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/)
    .nullable(),
});

/**
 * PATCH /api/projects/:id/github
 * Connect or disconnect a GitHub repo for a project.
 */
export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    const body = await req.json();
    const { githubRepo } = patchSchema.parse(body);

    const project = await updateProject(id, {
      githubRepo,
    });

    return NextResponse.json({
      data: {
        connected: !!project.githubRepo,
        repo: project.githubRepo,
      },
    });
  },
);
