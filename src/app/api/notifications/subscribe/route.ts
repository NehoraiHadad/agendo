import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { pushSubscriptions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

interface PushSubscriptionBody {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = (await req.json()) as PushSubscriptionBody;

  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
    return NextResponse.json({ error: 'Invalid subscription object' }, { status: 400 });
  }

  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    })
    .onConflictDoNothing();

  return new NextResponse(null, { status: 201 });
});

export const DELETE = withErrorBoundary(async (req: NextRequest) => {
  const body = (await req.json()) as { endpoint: string };

  if (!body?.endpoint) {
    return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
  }

  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, body.endpoint));

  return new NextResponse(null, { status: 204 });
});
