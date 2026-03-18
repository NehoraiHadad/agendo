import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { fetchOpenAIUsage } from '@/lib/services/usage-service';

export const GET = withErrorBoundary(async () => {
  const result = await fetchOpenAIUsage();

  if (result.status === 'no_credentials') {
    return NextResponse.json(
      { error: { code: 'NO_CREDENTIALS', message: 'OpenAI/Codex OAuth credentials not found' } },
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
