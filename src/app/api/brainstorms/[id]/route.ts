import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm, deleteBrainstorm } from '@/lib/services/brainstorm-service';
import { db } from '@/lib/db';
import { brainstormRooms } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError } from '@/lib/errors';

const updateBrainstormSchema = z.object({
  title: z.string().min(1).optional(),
  maxWaves: z.number().int().min(1).max(100).optional(),
});

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const room = await getBrainstorm(id);
    return NextResponse.json({ data: room });
  },
);

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = updateBrainstormSchema.parse(await req.json());

    const updates: Partial<{ title: string; maxWaves: number; updatedAt: Date }> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.maxWaves !== undefined) updates.maxWaves = body.maxWaves;

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
    }

    const [updated] = await db
      .update(brainstormRooms)
      .set(updates)
      .where(eq(brainstormRooms.id, id))
      .returning();

    if (!updated) throw new NotFoundError('BrainstormRoom', id);
    return NextResponse.json({ data: updated });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');
    await deleteBrainstorm(id);
    return new NextResponse(null, { status: 204 });
  },
);
