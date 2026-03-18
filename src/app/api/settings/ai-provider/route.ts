import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { getAiProviderPreference, setAiProviderPreference } from '@/lib/services/settings-service';
import { getAvailableProviders, type AiProvider } from '@/lib/services/ai-call';
import { checkAuthStatus } from '@/lib/services/agent-auth-service';

const putSchema = z.object({
  provider: z.enum(['auto', 'anthropic', 'openai', 'gemini']),
});

/** Maps ai-call provider names to agent binary names used by checkAuthStatus */
const PROVIDER_TO_BINARY: Record<AiProvider, string> = {
  anthropic: 'claude',
  openai: 'codex',
  gemini: 'gemini',
};

export const GET = withErrorBoundary(async () => {
  const preference = getAiProviderPreference();
  const availableProviders = getAvailableProviders();

  // Detect providers that have CLI auth but no usable API credential
  const cliOnlyProviders: AiProvider[] = [];
  for (const [provider, binary] of Object.entries(PROVIDER_TO_BINARY)) {
    if (!availableProviders.includes(provider as AiProvider)) {
      const status = checkAuthStatus(binary);
      if (status.isAuthenticated) {
        cliOnlyProviders.push(provider as AiProvider);
      }
    }
  }

  return NextResponse.json({
    data: {
      preference,
      availableProviders,
      cliOnlyProviders,
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
