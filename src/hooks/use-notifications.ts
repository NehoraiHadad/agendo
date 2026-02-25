'use client';

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const arr = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) arr[i] = rawData.charCodeAt(i);
  return arr.buffer;
}

export type NotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported';

const noop = () => () => {};
const getSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const getNotSupported = () => false;

export function useNotifications() {
  const isSupported = useSyncExternalStore(noop, getSupported, getNotSupported);
  const [permission, setPermission] = useState<NotificationPermission>('unsupported');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Read initial permission and subscription after hydration
  useEffect(() => {
    if (!isSupported) return;
    // Read permission and subscription asynchronously to avoid synchronous setState in effect
    navigator.serviceWorker.ready
      .then((reg) => {
        setPermission(Notification.permission as NotificationPermission);
        return reg.pushManager.getSubscription();
      })
      .then((sub) => setIsSubscribed(sub !== null))
      .catch(() => {});
  }, [isSupported]);

  const subscribe = useCallback(async () => {
    if (!isSupported) return;
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) {
      console.warn('[PWA] NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set');
      return;
    }

    setIsLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm as NotificationPermission);
      if (perm !== 'granted') return;

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(vapidKey),
      });

      await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });

      setIsSubscribed(true);
    } catch (err) {
      console.error('[PWA] Subscribe failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isSupported]);

  const unsubscribe = useCallback(async () => {
    if (!isSupported) return;
    setIsLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/notifications/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
        setIsSubscribed(false);
      }
    } catch (err) {
      console.error('[PWA] Unsubscribe failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isSupported]);

  return { isSupported, permission, isSubscribed, isLoading, subscribe, unsubscribe };
}
