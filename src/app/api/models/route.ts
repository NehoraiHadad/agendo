import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getModelsForProvider, resolveProvider } from '@/lib/services/model-service';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const provider = req.nextUrl.searchParams.get('provider');
  if (!provider) {
    return NextResponse.json(
      { error: 'Missing required query parameter: provider' },
      { status: 400 },
    );
  }

  const resolved = resolveProvider(provider);
  if (!resolved) {
    return NextResponse.json(
      { error: `Unknown provider: "${provider}". Use claude, codex, or gemini.` },
      { status: 400 },
    );
  }

  const models = await getModelsForProvider(resolved);
  return NextResponse.json({ data: models });
});
