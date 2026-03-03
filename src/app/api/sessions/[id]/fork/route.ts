import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { forkSession } from '@/lib/services/session-service';

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const resumeAt = typeof body.resumeAt === 'string' ? body.resumeAt : undefined;
    const initialPrompt = typeof body.initialPrompt === 'string' ? body.initialPrompt : undefined;

    const fork = await forkSession(id, resumeAt, initialPrompt);

    return NextResponse.json({ data: { id: fork.id } }, { status: 201 });
  },
);
