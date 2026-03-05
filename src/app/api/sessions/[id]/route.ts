import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import {
  getSessionWithDetails,
  updateSessionTitle,
  deleteSession,
} from '@/lib/services/session-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const data = await getSessionWithDetails(id);
    return NextResponse.json({ data });
  },
);

const patchSchema = z.object({
  title: z.string().max(200).nullable(),
});

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const body = await req.json();
    const { title } = patchSchema.parse(body);

    const updated = await updateSessionTitle(id, title);
    return NextResponse.json({ data: updated });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');
    await deleteSession(id);
    return new NextResponse(null, { status: 204 });
  },
);
