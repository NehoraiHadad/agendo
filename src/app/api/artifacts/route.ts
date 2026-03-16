import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { createArtifact, listArtifactsBySession } from '@/lib/services/artifact-service';

const createArtifactSchema = z.object({
  sessionId: z.string().uuid().optional().nullable(),
  planId: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(500),
  type: z.enum(['html', 'svg']).default('html'),
  content: z.string().min(1),
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = createArtifactSchema.parse(await req.json());
  const artifact = await createArtifact(body);
  return NextResponse.json({ data: artifact }, { status: 201 });
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ data: [] });
  }
  const list = await listArtifactsBySession(sessionId);
  return NextResponse.json({ data: list });
});
