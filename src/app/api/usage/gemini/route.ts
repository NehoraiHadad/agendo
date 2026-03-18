import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { fetchGeminiUsage } from '@/lib/services/usage-service';

export const GET = withErrorBoundary(async () => {
  const result = await fetchGeminiUsage();

  if (result.status === 'no_credentials') {
    return NextResponse.json(
      { error: { code: 'NO_CREDENTIALS', message: 'Gemini CLI OAuth credentials not found' } },
      { status: 503 },
    );
  }

  if (result.status === 'error') {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_ERROR', message: result.error } },
      { status: 502 },
    );
  }

  return NextResponse.json({ data: result });
});
