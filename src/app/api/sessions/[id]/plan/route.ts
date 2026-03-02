import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';

/**
 * GET /api/sessions/[id]/plan
 *
 * Returns the plan file content for a session (written by Claude Code when
 * ExitPlanMode fires). Used by the ExitPlanMode UI to render the plan with
 * proper markdown formatting before the user approves or rejects.
 */
export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const session = await getSession(id);

    let content: string | null = null;
    if (session.planFilePath) {
      try {
        content = readFileSync(session.planFilePath, 'utf-8').trim() || null;
      } catch {
        content = null; // file may have been deleted or not yet written
      }
    }

    return NextResponse.json({ data: { content, hasPlan: content !== null } });
  },
);
