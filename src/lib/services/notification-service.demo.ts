/**
 * Demo-mode shadow for notification-service.
 *
 * Push notifications have no meaning in demo mode — this is a no-op shadow.
 */

import type { PushPayload } from './notification-service';

export async function sendPushToAll(_payload: PushPayload): Promise<void> {
  // No-op in demo mode — no push subscriptions exist, VAPID keys not configured.
}
