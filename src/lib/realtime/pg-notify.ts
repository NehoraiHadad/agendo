import { Pool } from 'pg';
import { config } from '@/lib/config';

// Dedicated pool for LISTEN connections (cannot share with Drizzle pool).
// Each subscribe() call acquires one client from this pool.
let listenerPool: Pool | null = null;

function getListenerPool(): Pool {
  if (!listenerPool) {
    listenerPool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
  }
  return listenerPool;
}

/** Sanitise UUID for use as a PG channel name (remove hyphens). */
export function channelName(prefix: 'agendo_events' | 'agendo_control', sessionId: string): string {
  return `${prefix}_${sessionId.replace(/-/g, '')}`;
}

/**
 * Publish a payload to a PG NOTIFY channel.
 * Uses the Drizzle pool (one query, no dedicated connection needed).
 * Truncates to a {type:'ref'} stub if payload exceeds 7500 bytes.
 */
export async function publish(channel: string, payload: unknown): Promise<void> {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  const serialized = JSON.stringify(payload);
  const safe =
    serialized.length > 7500
      ? JSON.stringify({
          type: 'ref',
          originalType: (payload as { type?: string }).type ?? 'unknown',
        })
      : serialized;
  await db.execute(sql`SELECT pg_notify(${channel}, ${safe})`);
}

/**
 * Subscribe to a PG NOTIFY channel.
 * Returns an unsubscribe function that releases the connection.
 *
 * IMPORTANT: We must hold a reference to the handler function and remove it
 * via client.off() before releasing the client back to the pool. Without this,
 * a reused pool client accumulates stale handlers from previous subscriptions
 * and fires them all when a new notification arrives — causing duplicate events.
 */
export async function subscribe(
  channel: string,
  callback: (payload: string) => void,
): Promise<() => void> {
  const client = await getListenerPool().connect();
  await client.query(`LISTEN "${channel}"`);
  const handler = (msg: { channel: string; payload?: string }) => {
    if (msg.channel === channel && msg.payload) callback(msg.payload);
  };
  client.on('notification', handler);
  return () => {
    client.off('notification', handler);
    client.query(`UNLISTEN "${channel}"`).catch(() => {});
    client.release();
  };
}
