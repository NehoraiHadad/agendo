import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { workerHeartbeats } from '@/lib/db/schema';

export const GET = withErrorBoundary(async () => {
  const workers = await db.select().from(workerHeartbeats);
  return NextResponse.json({ data: workers });
});
