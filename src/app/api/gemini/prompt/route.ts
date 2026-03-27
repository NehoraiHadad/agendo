/**
 * POST /api/gemini/prompt
 *
 * Lightweight Gemini utility endpoint. Uses `gemini -p "..." -o stream-json` (CLI/OAuth
 * billing tier) for simple one-shot prompts — no sessions, no worker.
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
import { z } from 'zod';
import { BadRequestError } from '@/lib/errors';
import { withErrorBoundary } from '@/lib/api-handler';
import { spawnGeminiHeadless, runGeminiPrompt } from '@/lib/gemini/headless';
import { SSE_HEADERS } from '@/lib/sse/constants';
import { encodeSSE } from '@/lib/sse/encoder';
import { getErrorMessage } from '@/lib/utils/error-utils';

const bodySchema = z.object({
  prompt: z.string().min(1).max(50_000),
  model: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
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
    throw new BadRequestError(getErrorMessage(err));
  }
});

function streamingResponse(req: NextRequest, body: z.infer<typeof bodySchema>): NextResponse {
  const readable = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        try {
          controller.enqueue(encodeSSE(data));
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
        send({ type: 'error', message: getErrorMessage(err) });
      } finally {
        controller.close();
      }
    },
    // cancel() is called on client disconnect — req.signal fires and cascades into spawnGeminiHeadless
  });

  return new NextResponse(readable, { headers: SSE_HEADERS });
}
