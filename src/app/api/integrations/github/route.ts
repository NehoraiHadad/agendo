import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getGitHubToken, detectGitHubRepo } from '@/lib/services/github-service';
import { createGitHubIssueForTask } from '@/lib/services/github-sync-service';
import { enqueueGitHubSync } from '@/lib/worker/github-sync-queue';

/**
 * GET /api/integrations/github
 * Returns GitHub integration status: token availability, connected projects.
 */
export const GET = withErrorBoundary(async () => {
  const tokenInfo = await getGitHubToken();
  return NextResponse.json({
    data: {
      hasToken: !!tokenInfo,
      tokenSource: tokenInfo?.source ?? null,
      username: tokenInfo?.username ?? null,
    },
  });
});

const syncSchema = z.object({
  action: z.enum(['sync', 'detect-repo', 'create-issue']),
  projectId: z.string().uuid().optional(),
  rootPath: z.string().optional(),
  taskId: z.string().uuid().optional(),
});

/**
 * POST /api/integrations/github
 * Actions:
 * - sync: Trigger a manual GitHub sync for all or a specific project
 * - detect-repo: Detect GitHub repo from a rootPath
 * - create-issue: Create a GitHub issue for an Agendo task
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const { action, projectId, rootPath, taskId } = syncSchema.parse(body);

  switch (action) {
    case 'sync': {
      const jobId = await enqueueGitHubSync(projectId ? { projectId } : {});
      return NextResponse.json({ data: { jobId, message: 'GitHub sync enqueued' } });
    }

    case 'detect-repo': {
      if (!rootPath) {
        return NextResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: 'rootPath is required' } },
          { status: 422 },
        );
      }
      const repo = await detectGitHubRepo(rootPath);
      return NextResponse.json({ data: { repo } });
    }

    case 'create-issue': {
      if (!taskId) {
        return NextResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: 'taskId is required' } },
          { status: 422 },
        );
      }
      assertUUID(taskId, 'Task');
      const result = await createGitHubIssueForTask(taskId);
      if (!result) {
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: 'Could not create issue (no token or no repo)' } },
          { status: 404 },
        );
      }
      return NextResponse.json({ data: result }, { status: 201 });
    }
  }
});
