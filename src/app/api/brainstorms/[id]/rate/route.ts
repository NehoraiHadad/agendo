import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { brainstormRooms } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError } from '@/lib/errors';

const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = rateSchema.parse(await req.json());

    const [updated] = await db
      .update(brainstormRooms)
      .set({ rating: body.rating, updatedAt: new Date() })
      .where(eq(brainstormRooms.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('BrainstormRoom', id);
    }

    return NextResponse.json({ data: { success: true } });
  },
);
