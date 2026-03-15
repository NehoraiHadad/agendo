import { Pool, PoolClient } from 'pg';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import type { SessionStatus } from '@/lib/realtime/event-types';

const log = createLogger('pg-notify');

// Dedicated pool for LISTEN connections (cannot share with Drizzle pool).
// With the multiplexer, we need at most one connection per distinct channel
// (not one per subscriber). Worker uses ~13 channels max for a brainstorm,
// frontend SSE reuses channels. max=20 is plenty.
let listenerPool: Pool | null = null;

function getListenerPool(): Pool {
  if (!listenerPool) {
    listenerPool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 20,
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

// ============================================================================
// Channel multiplexer — one PG connection per channel, fan out to N listeners
// ============================================================================

type Callback = (payload: string) => void;

interface ChannelSlot {
  client: PoolClient;
  listeners: Set<Callback>;
  heartbeatTimer: ReturnType<typeof setInterval>;
  dead: boolean;
}

/** Map from channel name → shared slot. */
const channels = new Map<string, ChannelSlot>();
/** Channels currently reconnecting — prevents duplicate reconnect attempts. */
const reconnecting = new Set<string>();

/**
 * Set up a new PG LISTEN client for a channel.
 * All listeners in the slot's Set receive every notification.
 */
async function createChannelSlot(channel: string): Promise<ChannelSlot> {
  const client = await getListenerPool().connect();
  await client.query(`LISTEN "${channel}"`);

  const slot: ChannelSlot = {
    client,
    listeners: new Set(),
    heartbeatTimer: null as unknown as ReturnType<typeof setInterval>,
    dead: false,
  };

  client.on('notification', (msg: { channel: string; payload?: string }) => {
    if (msg.channel === channel && msg.payload) {
      for (const cb of slot.listeners) {
        try {
          cb(msg.payload);
        } catch {
          // Individual listener error — don't break others
        }
      }
    }
  });

  client.on('error', (err) => {
    if (slot.dead) return;
    log.warn({ channel, err }, 'pg-notify channel slot error — reconnecting');
    reconnectSlot(channel, slot);
  });

  // Heartbeat every 60s
  slot.heartbeatTimer = setInterval(() => {
    if (slot.dead || slot.listeners.size === 0) return;
    slot.client.query('SELECT 1').catch((err) => {
      log.debug({ channel, err }, 'pg-notify heartbeat failed');
    });
  }, 60_000);

  return slot;
}

/** Reconnect a channel slot, preserving all listeners. */
function reconnectSlot(channel: string, oldSlot: ChannelSlot): void {
  if (reconnecting.has(channel)) return;
  reconnecting.add(channel);

  // Clean up old slot
  clearInterval(oldSlot.heartbeatTimer);
  oldSlot.dead = true;
  try {
    oldSlot.client.release(true);
  } catch {
    /* already released */
  }

  const listeners = oldSlot.listeners;
  channels.delete(channel);

  if (listeners.size === 0) {
    reconnecting.delete(channel);
    return;
  }

  const attempt = (n: number) => {
    const delayMs = Math.min(1_000 * 2 ** n, 8_000);
    log.info({ channel, attempt: n, delayMs, listeners: listeners.size }, 'pg-notify reconnecting');

    setTimeout(() => {
      if (listeners.size === 0) {
        reconnecting.delete(channel);
        return;
      }

      createChannelSlot(channel)
        .then((newSlot) => {
          for (const cb of listeners) {
            newSlot.listeners.add(cb);
          }
          channels.set(channel, newSlot);
          reconnecting.delete(channel);
          log.info({ channel, listeners: listeners.size }, 'pg-notify reconnect succeeded');
        })
        .catch((err) => {
          log.warn({ channel, attempt: n, err }, 'pg-notify reconnect failed — retrying');
          attempt(n + 1);
        });
    }, delayMs);
  };

  attempt(0);
}

/** Tear down a channel slot when its last listener unsubscribes. */
function destroySlot(channel: string, slot: ChannelSlot): void {
  slot.dead = true;
  clearInterval(slot.heartbeatTimer);
  channels.delete(channel);
  slot.client.query(`UNLISTEN "${channel}"`).catch(() => {});
  slot.client.release();
}

/**
 * Subscribe to a PG NOTIFY channel.
 * Returns an unsubscribe function that removes this listener.
 *
 * Uses a multiplexer: the first subscriber on a channel creates a PG LISTEN
 * connection; subsequent subscribers share it. The connection is released
 * when the last subscriber unsubscribes. This prevents connection pool
 * exhaustion from browser SSE reconnections.
 */
export async function subscribe(channel: string, callback: Callback): Promise<() => void> {
  let slot = channels.get(channel);

  if (!slot) {
    slot = await createChannelSlot(channel);
    channels.set(channel, slot);
  }

  slot.listeners.add(callback);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;

    const currentSlot = channels.get(channel);
    if (!currentSlot) return;

    currentSlot.listeners.delete(callback);

    // Last listener — tear down the PG connection
    if (currentSlot.listeners.size === 0) {
      destroySlot(channel, currentSlot);
    }
  };
}
