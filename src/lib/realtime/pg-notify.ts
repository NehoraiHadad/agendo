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
  const safe = serialized.length > 7500
    ? JSON.stringify({ type: 'ref', originalType: (payload as { type?: string }).type ?? 'unknown' })
    : serialized;
  await db.execute(sql`SELECT pg_notify(${channel}, ${safe})`);
}

/**
 * Subscribe to a PG NOTIFY channel.
 * Returns an unsubscribe function that releases the connection.
 */
export async function subscribe(
  channel: string,
  callback: (payload: string) => void,
): Promise<() => void> {
  const client = await getListenerPool().connect();
  await client.query(`LISTEN "${channel}"`);
  client.on('notification', (msg) => {
    if (msg.channel === channel && msg.payload) callback(msg.payload);
  });
  return () => {
    client.query(`UNLISTEN "${channel}"`).catch(() => {});
    client.release();
  };
}
