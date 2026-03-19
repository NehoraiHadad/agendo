import { NextRequest } from 'next/server';
import { getJobLog, subscribeToJob } from '@/lib/upgrade/upgrade-manager';
import { SSE_HEADERS } from '@/lib/sse/constants';
import { encodeSSE, encodeHeartbeat } from '@/lib/sse/encoder';
import type { UpgradeSseEvent } from '@/lib/upgrade/upgrade-events';

export const dynamic = 'force-dynamic';

const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * GET /api/upgrade/[jobId]/stream
 * SSE stream for a specific upgrade job.
 * Replays buffered log lines on connect, then streams live events.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  function send(evt: UpgradeSseEvent): void {
    void writer.write(encodeSSE(evt)).catch(() => {});
  }

  function sendKeepAlive(): void {
    void writer.write(encodeHeartbeat()).catch(() => {});
  }

  // Replay historical log lines as catchup
  const catchupLines = getJobLog(jobId);
  for (const line of catchupLines) {
    send({ type: 'log', line });
  }

  let done = false;

  // Subscribe to live events
  const unsubscribe = subscribeToJob(jobId, (evt) => {
    send(evt);
    if (evt.type === 'done' || evt.type === 'error') {
      done = true;
      clearInterval(keepaliveTimer);
      void writer.close().catch(() => {});
    }
  });

  // Keepalive ping to prevent proxy timeouts
  const keepaliveTimer = setInterval(sendKeepAlive, KEEPALIVE_INTERVAL_MS);

  // Cleanup on client disconnect
  req.signal.addEventListener('abort', () => {
    if (!done) {
      clearInterval(keepaliveTimer);
      unsubscribe();
      void writer.close().catch(() => {});
    }
  });

  return new Response(readable, { status: 200, headers: SSE_HEADERS });
}
