import { Pool } from 'pg';
import { config } from '@/lib/config';
import type { SessionStatus } from '@/lib/realtime/event-types';

// Dedicated pool for LISTEN connections (cannot share with Drizzle pool).
// Each subscribe() call acquires one client from this pool.
let listenerPool: Pool | null = null;

function getListenerPool(): Pool {
  if (!listenerPool) {
    // Each subscribe() call holds one connection for the LISTEN lifetime.
    // Brainstorm sizing (6 participants): 6 session control + 6 orchestrator event +
    // 1 orchestrator control = 13 connections. Plus standalone user sessions (~6 concurrent
    // with WORKER_MAX_CONCURRENT_JOBS=6) = ~6 more. Buffer for SSE and misc = 21+.
    // Set max=40 to comfortably handle concurrent brainstorms + regular sessions.
    listenerPool = new Pool({ connectionString: config.DATABASE_URL, max: 40 });
  }
  return listenerPool;
}

/** Sanitise UUID for use as a PG channel name (remove hyphens). */
export function channelName(
  prefix: 'agendo_events' | 'agendo_control' | 'brainstorm_events' | 'brainstorm_control',
  id: string,
): string {
  return `${prefix}_${id.replace(/-/g, '')}`;
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
 * Broadcast a session status change via PG NOTIFY.
 *
 * Used by out-of-band status updaters (stale-reaper, zombie-reconciler,
 * cancel API) that change session status in the DB but don't have a
 * SessionProcess instance to emit the event. Without this, the frontend
 * SSE stream never sees the status change.
 */
export async function broadcastSessionStatus(
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  const event = {
    id: 0, // synthetic — no eventSeq tracking outside SessionProcess
    sessionId,
    ts: Date.now(),
    type: 'session:state' as const,
    status,
  };
  await publish(channelName('agendo_events', sessionId), event);
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
