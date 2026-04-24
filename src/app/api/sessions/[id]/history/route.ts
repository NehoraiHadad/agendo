import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSessionHistory } from '@/lib/services/session-history-service';
import { isDemoMode } from '@/lib/demo/flag';
import { DEMO_SESSION_EVENTS } from '@/lib/demo/fixtures/sessions';
import type { AgendoEvent } from '@/lib/realtime/event-types';
import type { SessionHistoryResult } from '@/lib/services/session-history-service';

/** Ephemeral event types excluded from history (mirrors event-utils.ts). */
const EPHEMERAL_EVENT_TYPES = new Set(['agent:text-delta', 'agent:thinking-delta']);

/**
 * Builds a SessionHistoryResult from demo fixture events.
 *
 * Fixture ReplayableEvent objects carry `payload: AgendoEventPayload`. To
 * produce the full AgendoEvent envelope expected by the UI, we merge in the
 * EventBase fields: { id (seq), sessionId, ts (startTs + atMs) }.
 *
 * Ephemeral events (text-delta, thinking-delta) are excluded to match the
 * real session-history-service behaviour. Pagination (beforeSeq/afterSeq/limit)
 * is honoured by filtering the derived seq numbers.
 */
function buildDemoHistoryResult(
  sessionId: string,
  opts: { beforeSeq?: number; afterSeq?: number; limit?: number },
): SessionHistoryResult | null {
  const rawEvents = DEMO_SESSION_EVENTS[sessionId];
  if (!rawEvents) return null;

  // Stable replay start timestamp — use a fixed epoch so seq IDs don't shift
  // between calls (keeps totalCount / oldestSeq / newestSeq deterministic).
  const startTs = 1_700_000_000_000; // fixed demo epoch (ms)

  // Assign monotonic seq IDs only to non-ephemeral events (matching real log
  // behaviour where ephemeral events are not persisted/counted).
  const allEvents: AgendoEvent[] = [];
  let seq = 0;
  const sorted = [...rawEvents].sort((a, b) => a.atMs - b.atMs);

  for (const event of sorted) {
    if (EPHEMERAL_EVENT_TYPES.has(event.type)) continue;
    seq++;
    const envelope = {
      id: seq,
      sessionId,
      ts: startTs + event.atMs,
      // Spread the payload fields (which already include `type`) on top
      ...(event.payload as Record<string, unknown>),
    } as AgendoEvent;
    allEvents.push(envelope);
  }

  const totalCount = allEvents.length;

  // Apply cursor filters (capture as locals so TS narrows correctly in callbacks)
  const { beforeSeq, afterSeq } = opts;
  let filtered = allEvents;
  if (beforeSeq != null) {
    filtered = filtered.filter((e) => e.id < beforeSeq);
  }
  if (afterSeq != null) {
    filtered = filtered.filter((e) => e.id > afterSeq);
  }

  // Determine hasMore before applying the limit
  const hasMore = filtered.length < allEvents.length;

  // Apply limit (take latest N when scrolling back via beforeSeq, else oldest N)
  const effectiveLimit = opts.limit ?? 500;
  if (filtered.length > effectiveLimit) {
    filtered =
      beforeSeq != null
        ? filtered.slice(filtered.length - effectiveLimit)
        : filtered.slice(0, effectiveLimit);
  }

  const first = filtered[0];
  const last = filtered[filtered.length - 1];

  return {
    sessionId,
    events: filtered,
    hasMore,
    totalCount,
    oldestSeq: first != null ? first.id : null,
    newestSeq: last != null ? last.id : null,
  };
}

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

    if (isDemoMode()) {
      const result = buildDemoHistoryResult(id, {
        beforeSeq: beforeSeq ? parseInt(beforeSeq, 10) : undefined,
        afterSeq: afterSeq ? parseInt(afterSeq, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : 500,
      });
      if (!result) {
        return new NextResponse('Unknown demo session', { status: 404 });
      }
      return NextResponse.json(result);
    }

    const result = await getSessionHistory(id, {
      beforeSeq: beforeSeq ? parseInt(beforeSeq, 10) : undefined,
      afterSeq: afterSeq ? parseInt(afterSeq, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 500,
    });

    return NextResponse.json(result);
  },
);
