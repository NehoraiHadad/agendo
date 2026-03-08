/**
 * POST /api/gemini/prompt
 *
 * Lightweight Gemini utility endpoint. Uses `gemini -p "..." -o stream-json` (CLI/OAuth
 * billing tier) for simple one-shot prompts — no sessions, no pg-boss, no worker.
 *
 * One-shot (JSON):
 *   POST /api/gemini/prompt
 *   { "prompt": "Translate to French: Hello", "model": "gemini-2.5-flash" }
 *   → { "data": { "text": "...", "sessionId": "...", "model": "...", "stats": {...} } }
 *
 * Streaming (SSE):
 *   POST /api/gemini/prompt?stream=true
 *   → text/event-stream with events: init | text-delta | tool-start | tool-end | result | error
 */

import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { AppError } from '@/lib/errors';
import { BadRequestError } from '@/lib/errors';
import { spawnGeminiHeadless, runGeminiPrompt } from '@/lib/gemini/headless';

const bodySchema = z.object({
  prompt: z.string().min(1).max(50_000),
  model: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const stream = req.nextUrl.searchParams.get('stream') === 'true';
    const body = bodySchema.parse(await req.json());

    if (stream) {
      return streamingResponse(req, body);
    }

    // One-shot: wait for the full result and return JSON
    try {
      const result = await runGeminiPrompt({
        prompt: body.prompt,
        model: body.model,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        signal: req.signal,
      });
      return NextResponse.json({ data: result });
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : 'Gemini prompt failed');
    }
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json(error.toJSON(), { status: error.statusCode });
    }
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            context: { issues: error.issues },
          },
        },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

function streamingResponse(req: NextRequest, body: z.infer<typeof bodySchema>): NextResponse {
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Client disconnected — controller is already closed
        }
      }

      try {
        for await (const event of spawnGeminiHeadless({
          prompt: body.prompt,
          model: body.model,
          cwd: body.cwd,
          timeoutMs: body.timeoutMs,
          signal: req.signal,
        })) {
          switch (event.type) {
            case 'init':
              send({ type: 'init', sessionId: event.session_id, model: event.model });
              break;
            case 'message':
              if (event.role === 'assistant') {
                send({ type: 'text-delta', text: event.content });
              }
              break;
            case 'tool_use':
              send({ type: 'tool-start', toolName: event.tool_name, toolId: event.tool_id });
              break;
            case 'tool_result':
              send({
                type: 'tool-end',
                toolId: event.tool_id,
                status: event.status,
                output: event.output,
              });
              break;
            case 'result':
              send({ type: 'result', status: event.status, stats: event.stats });
              break;
          }
        }
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
      } finally {
        controller.close();
      }
    },
    // cancel() is called on client disconnect — req.signal fires and cascades into spawnGeminiHeadless
  });

  return new NextResponse(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
