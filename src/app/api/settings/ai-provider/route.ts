import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { getAiProviderPreference, setAiProviderPreference } from '@/lib/services/settings-service';
import { getAvailableProviders } from '@/lib/services/ai-call';

const putSchema = z.object({
  provider: z.enum(['auto', 'anthropic', 'openai', 'gemini']),
});

export const GET = withErrorBoundary(async () => {
  const preference = getAiProviderPreference();
  const availableProviders = getAvailableProviders();

  return NextResponse.json({
    data: {
      preference,
      availableProviders,
    },
  });
});

export const PUT = withErrorBoundary(async (req: NextRequest) => {
  const body = putSchema.parse(await req.json());
  setAiProviderPreference(body.provider);

  return NextResponse.json({
    data: { preference: body.provider },
  });
});
