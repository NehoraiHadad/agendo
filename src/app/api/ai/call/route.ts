import { withErrorBoundary } from '@/lib/api-handler';
import { aiCall, getAvailableProviders, type AiProvider } from '@/lib/services/ai-call';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const RequestSchema = z.object({
  prompt: z.string().min(1).max(10_000),
  preferredProvider: z.enum(['anthropic', 'openai', 'gemini']).optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
});

/**
 * POST /api/ai/call
 * Make a single AI API call with automatic provider fallback.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = RequestSchema.parse(await req.json());

  const result = await aiCall({
    prompt: body.prompt,
    preferredProvider: body.preferredProvider as AiProvider | undefined,
    maxTokens: body.maxTokens,
  });

  return NextResponse.json(result);
});

/**
 * GET /api/ai/call
 * Returns available AI providers (no keys exposed).
 */
export const GET = withErrorBoundary(async () => {
  const providers = getAvailableProviders();
  return NextResponse.json({ providers, available: providers.length > 0 });
});
