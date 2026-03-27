import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSessionHistory } from '@/lib/services/session-history-service';

/**
 * GET /api/sessions/:id/history — Paginated session event history
 *
 * Query params:
 *   - beforeSeq: Return events with id < beforeSeq (scroll back)
 *   - afterSeq:  Return events with id > afterSeq (scroll forward)
 *   - limit:     Max events to return (default: 500)
 *
 * Response: {
 *   sessionId, events[], hasMore, totalCount, oldestSeq, newestSeq
 * }
 */
export const GET = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const url = new URL(req.url);
    const beforeSeq = url.searchParams.get('beforeSeq');
    const afterSeq = url.searchParams.get('afterSeq');
    const limit = url.searchParams.get('limit');

    const result = await getSessionHistory(id, {
      beforeSeq: beforeSeq ? parseInt(beforeSeq, 10) : undefined,
      afterSeq: afterSeq ? parseInt(afterSeq, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 500,
    });

    return NextResponse.json(result);
  },
);
