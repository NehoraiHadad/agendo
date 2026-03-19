import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { BadRequestError } from '@/lib/errors';
import { getCompletedRoomsForProject } from '@/lib/services/brainstorm-service';

/**
 * GET /api/brainstorms/completed?projectId=<uuid>
 *
 * Returns completed brainstorm rooms with syntheses for a given project.
 * Used by the create dialog's "Related brainstorms" picker.
 */
export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');

  if (!projectId) {
    throw new BadRequestError('projectId query parameter is required');
  }

  const rooms = await getCompletedRoomsForProject(projectId);
  return NextResponse.json({ data: rooms });
});
