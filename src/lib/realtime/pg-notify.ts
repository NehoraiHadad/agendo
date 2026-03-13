import { Pool, PoolClient } from 'pg';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import type { SessionStatus } from '@/lib/realtime/event-types';

const log = createLogger('pg-notify');

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
    //
    // keepAlive: true — enables TCP keepalive probes so the OS detects dead connections
    // within ~60-90s rather than after the 2-hour default tcp_keepalives_idle.
    listenerPool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 40,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    });
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
 * Mutable reference wrapper used to swap out the active LISTEN client
 * on reconnect without invalidating the outer unsubscribe closure.
 */
interface ClientRef {
  client: PoolClient;
  handler: (msg: { channel: string; payload?: string }) => void;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  dead: boolean;
}

/**
 * Acquire a new LISTEN client and attach the notification + error handlers.
 * Mutates the provided `ref` in-place so the outer unsubscribe closure
 * continues to reference the current (possibly reconnected) client.
 */
async function setupListenClient(
  channel: string,
  callback: (payload: string) => void,
  ref: ClientRef,
): Promise<void> {
  // Clear old heartbeat timer before acquiring a new client.
  if (ref.heartbeatTimer !== null) {
    clearInterval(ref.heartbeatTimer);
    ref.heartbeatTimer = null;
  }

  const client = await getListenerPool().connect();
  await client.query(`LISTEN "${channel}"`);

  const handler = (msg: { channel: string; payload?: string }) => {
    if (msg.channel === channel && msg.payload) callback(msg.payload);
  };

  client.on('notification', handler);

  // Error handler: log, release the dead client, and reconnect — unless
  // the subscription has already been torn down by the caller.
  client.on('error', (err) => {
    if (ref.dead) return;
    log.warn({ channel, err }, 'pg-notify LISTEN client error — reconnecting');

    if (ref.heartbeatTimer !== null) {
      clearInterval(ref.heartbeatTimer);
      ref.heartbeatTimer = null;
    }

    // Remove the old handler before releasing to prevent stale callbacks.
    client.off('notification', ref.handler);
    client.release(true); // `true` destroys the connection rather than pooling it

    reconnect(channel, callback, ref);
  });

  ref.client = client;
  ref.handler = handler;

  // Periodic heartbeat: send a lightweight SELECT 1 every 60 seconds.
  // If it fails the error event above handles reconnect.
  ref.heartbeatTimer = setInterval(() => {
    if (ref.dead) {
      clearInterval(ref.heartbeatTimer as ReturnType<typeof setInterval>);
      ref.heartbeatTimer = null;
      return;
    }
    ref.client.query('SELECT 1').catch((err) => {
      // The error event on the client will fire separately and handle reconnect.
      log.debug({ channel, err }, 'pg-notify heartbeat failed');
    });
  }, 60_000);
}

/** Reconnect with simple back-off: 1s, 2s, 4s, then every 8s. */
function reconnect(
  channel: string,
  callback: (payload: string) => void,
  ref: ClientRef,
  attempt = 0,
): void {
  if (ref.dead) return;

  const delayMs = Math.min(1_000 * 2 ** attempt, 8_000);
  log.info({ channel, attempt, delayMs }, 'pg-notify reconnecting');

  setTimeout(() => {
    if (ref.dead) return;
    setupListenClient(channel, callback, ref)
      .then(() => {
        log.info({ channel }, 'pg-notify reconnect succeeded');
      })
      .catch((err) => {
        log.warn({ channel, attempt, err }, 'pg-notify reconnect attempt failed — retrying');
        reconnect(channel, callback, ref, attempt + 1);
      });
  }, delayMs);
}

/**
 * Subscribe to a PG NOTIFY channel.
 * Returns an unsubscribe function that releases the connection.
 *
 * Improvements over the naive implementation:
 * - TCP keepalive on the pool detects dead connections within ~60-90 s.
 * - Error handler automatically reconnects when the LISTEN client dies.
 * - 60 s heartbeat (SELECT 1) catches stalls before keepalive probes fire.
 * - The returned unsubscribe function works correctly after any number of
 *   reconnects because it closes over the mutable `ref` wrapper.
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
  // Placeholder values overwritten immediately by setupListenClient.
  const ref: ClientRef = {
    client: null as unknown as PoolClient,
    handler: () => {},
    heartbeatTimer: null,
    dead: false,
  };

  await setupListenClient(channel, callback, ref);

  return () => {
    ref.dead = true;

    if (ref.heartbeatTimer !== null) {
      clearInterval(ref.heartbeatTimer);
      ref.heartbeatTimer = null;
    }

    ref.client.off('notification', ref.handler);
    ref.client.query(`UNLISTEN "${channel}"`).catch(() => {});
    ref.client.release();
  };
}
