import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { BadRequestError } from '@/lib/errors';
import { getModelsForProvider, getCacheAge, resolveProvider } from '@/lib/services/model-service';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const provider = req.nextUrl.searchParams.get('provider');
  if (!provider) {
    throw new BadRequestError('Missing required query parameter: provider');
  }

  const resolved = resolveProvider(provider);
  if (!resolved) {
    throw new BadRequestError(
      `Unknown provider: "${provider}". Use claude, codex, gemini, or copilot.`,
    );
  }

  const refresh = req.nextUrl.searchParams.get('refresh') === 'true';
  const models = await getModelsForProvider(resolved, { skipCache: refresh });
  const cachedAgoMs = getCacheAge(resolved);

  return NextResponse.json({ data: models, cachedAgoMs });
});
