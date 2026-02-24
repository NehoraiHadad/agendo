import webpush from 'web-push';
import { db } from '@/lib/db';
import { pushSubscriptions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { config } from '@/lib/config';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Sends a push notification to all subscribed browsers.
 * Silently skips if VAPID keys are not configured.
 * Auto-removes expired or invalid subscriptions (HTTP 410/404).
 */
export async function sendPushToAll(payload: PushPayload): Promise<void> {
  const vapidSubject = config.VAPID_SUBJECT;
  const vapidPublic = config.VAPID_PUBLIC_KEY;
  const vapidPrivate = config.VAPID_PRIVATE_KEY;
  if (!vapidSubject || !vapidPublic || !vapidPrivate) return;

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const subs = await db.select().from(pushSubscriptions);
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404) {
          // Subscription no longer valid — remove it
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
        }
      }
    }),
  );
}
