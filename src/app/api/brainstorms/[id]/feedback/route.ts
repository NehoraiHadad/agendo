import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';

const log = createLogger('brainstorm-feedback-api');

const feedbackSchema = z.object({
  wave: z.number().int().min(0),
  agentId: z.string().min(1),
  participantId: z.string().uuid().optional(),
  signal: z.enum(['thumbs_up', 'thumbs_down', 'focus']),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = feedbackSchema.parse(await req.json());

    // Validate the room exists
    await getBrainstorm(id);

    // Forward to the worker via Worker HTTP
    const workerUrl = `http://localhost:${config.WORKER_HTTP_PORT}/brainstorms/${id}/feedback`;
    try {
      const res = await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.JWT_SECRET}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        log.warn({ roomId: id, status: res.status }, 'Worker HTTP feedback request failed');
        // Non-fatal: feedback may arrive after review window closed
        return NextResponse.json({ data: { dispatched: false } });
      }

      const responseBody = (await res.json()) as { dispatched?: boolean };
      return NextResponse.json({ data: { dispatched: responseBody.dispatched ?? false } });
    } catch (err) {
      log.warn({ err, roomId: id }, 'Failed to forward feedback to worker');
      return NextResponse.json({ data: { dispatched: false } });
    }
  },
);
