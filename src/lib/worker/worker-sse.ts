/**
 * Worker-side SSE (Server-Sent Events) infrastructure.
 *
 * Instead of routing events through PG NOTIFY → Next.js SSE, the Worker
 * serves SSE directly on port 4102. Browser clients connect via a Next.js
 * rewrite proxy.
 *
 * Architecture:
 *   SessionProcess.emitEvent() → sessionEventListeners map → HTTP SSE stream
 *   BrainstormOrchestrator.emitEvent() → brainstormEventListeners map → HTTP SSE stream
 *
 * SSE reconnect catchup uses a 3-tier source hierarchy:
 *   1. CLI-native history (adapter.getHistory()) — conversation content
 *   2. Live state (proc.getLiveState()) — session:init from DB, team state from filesystem
 *   3. Log file (fallback) — for ended sessions or agents without getHistory() support
 */

import * as http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '@/lib/logger';
import { SSE_HEADERS } from '@/lib/sse/constants';
import { getSession } from '@/lib/services/session-service';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { readEventsFromLog, readBrainstormEventsFromLog } from '@/lib/realtime/event-utils';
import { getSessionProc } from '@/lib/worker/session-runner';
import type {
  AgendoEvent,
  BrainstormEvent,
  SessionStatus,
  BrainstormRoomStatus,
} from '@/lib/realtime/event-types';

const log = createLogger('worker-sse');

/** Keepalive interval to prevent SSE connection drops (proxies, browsers, load balancers). */
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Maximum events to send during SSE catchup (initial connect or log file replay).
 * Very long sessions may have 10k+ events; sending them all delays first paint
 * and overwhelms the client. Older events are available via the REST history API.
 */
const MAX_CATCHUP_EVENTS = 5000;

// ============================================================================
// Shared in-memory listener registries
// ============================================================================

/**
 * Create a typed event listener registry keyed by ID (sessionId, roomId, etc.).
 * Returns a Map of listener sets and an `add` function that returns an unsubscribe callback.
 */
function createEventListenerRegistry<T>(): {
  listeners: Map<string, Set<(event: T) => void>>;
  add: (id: string, cb: (event: T) => void) => () => void;
} {
  const listeners = new Map<string, Set<(event: T) => void>>();

  function add(id: string, cb: (event: T) => void): () => void {
    let set = listeners.get(id);
    if (!set) {
      set = new Set();
      listeners.set(id, set);
    }
    set.add(cb);

    return () => {
      const current = listeners.get(id);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) {
        listeners.delete(id);
      }
    };
  }

  return { listeners, add };
}

const sessionRegistry = createEventListenerRegistry<AgendoEvent>();
const brainstormRegistry = createEventListenerRegistry<BrainstormEvent>();

/**
 * Live SSE listeners for session events. Keyed by sessionId.
 * Populated by handleSessionSSE; consumed by SessionProcess.emitEvent().
 */
export const sessionEventListeners = sessionRegistry.listeners;

/**
 * Live SSE listeners for brainstorm events. Keyed by roomId.
 * Populated by handleBrainstormSSE; consumed by BrainstormOrchestrator.emitEvent().
 */
export const brainstormEventListeners = brainstormRegistry.listeners;

// ============================================================================
// Listener registration helpers
// ============================================================================

/**
 * Register a session event listener.
 * Returns an unsubscribe function that removes the listener.
 */
export const addSessionEventListener = sessionRegistry.add;

/**
 * Register a brainstorm event listener.
 * Returns an unsubscribe function that removes the listener.
 */
export const addBrainstormEventListener = brainstormRegistry.add;

// ============================================================================
// SSE helpers
// ============================================================================

function setSseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  // Flush headers immediately so the proxy doesn't buffer them
  res.flushHeaders();
}

function sendHeartbeat(res: http.ServerResponse): void {
  try {
    res.write(': heartbeat\n\n');
  } catch {
    // Client disconnected — ignore
  }
}

function sendEvent(res: http.ServerResponse, event: AgendoEvent | BrainstormEvent): void {
  try {
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    // Force flush so the Next.js rewrite proxy forwards immediately
    const maybeFlush = (res as NodeJS.WritableStream & { flush?: () => void }).flush;
    if (typeof maybeFlush === 'function') {
      maybeFlush.call(res);
    }
  } catch {
    // Client disconnected — write will throw, ignore
  }
}

// ============================================================================
// Session SSE handler
// ============================================================================

/**
 * Handle a GET /sessions/:id/events request as an SSE stream.
 *
 * Flow:
 *   1. Send current session state from DB
 *   2. Catchup: CLI-native history (primary) → log file (fallback)
 *   3. Register in-memory listener for live events
 *   4. Clean up on client disconnect
 */
export async function handleSessionSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  lastEventId: number,
): Promise<void> {
  let session;
  try {
    session = await getSession(sessionId);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  setSseHeaders(res);

  // Keepalive heartbeat to prevent proxy/browser timeout disconnects
  const heartbeatTimer = setInterval(() => sendHeartbeat(res), KEEPALIVE_INTERVAL_MS);

  // 1. Emit current session state immediately
  const stateEvent: AgendoEvent = {
    id: 0,
    sessionId: session.id,
    ts: Date.now(),
    type: 'session:state',
    status: session.status as SessionStatus,
  };
  sendEvent(res, stateEvent);

  // 2. Catchup: reconstruct state for the reconnecting browser.
  //
  //    3-tier source hierarchy:
  //      (a) CLI-native history via adapter.getHistory() — conversation content.
  //      (b) Live state via proc.getLiveState() — session:init from DB, team
  //          state from filesystem (inbox/config/task files).
  //      (c) Log file — full fallback for ended sessions or agents without
  //          getHistory() (Gemini, Copilot).
  //
  //    Tiers (a) and (b) read from their respective sources of truth.
  //    The log file is an audit trail, used only when live sources are unavailable.
  let catchupSent = false;

  // 3. Register in-memory listener BEFORE history send to avoid race condition.
  //    Any events emitted during the async getHistory() call are buffered and
  //    flushed after history is sent — no events are lost.
  const buffered: AgendoEvent[] = [];
  let liveFlushing = false;
  const unsub = addSessionEventListener(sessionId, (event) => {
    if (liveFlushing) {
      sendEvent(res, event);
    } else {
      buffered.push(event);
    }
  });

  // 4. Clean up on client disconnect (listen on multiple events for reliability through proxies)
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeatTimer);
    unsub();
    log.debug({ sessionId }, 'SSE client disconnected');
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
  res.on('finish', cleanup);

  // 2a. Try CLI-native history first (requires a live SessionProcess)
  // Skip on reconnect (lastEventId > 0) — client already has conversation history.
  // Re-sending CLI-native history with new sequential IDs causes message duplication
  // because the client deduplicates by event ID only.
  const proc = getSessionProc(sessionId);
  if (proc && lastEventId === 0) {
    try {
      const historyEvents = await proc.getHistory();
      if (historyEvents && historyEvents.length > 0) {
        // Skip the first user:message from CLI history when session.initialPrompt
        // is set — the UI already shows it via InitialPromptBanner.
        let skippedFirst = false;
        let filtered = session.initialPrompt
          ? historyEvents.filter((ev) => {
              if (!skippedFirst && ev.type === 'user:message') {
                skippedFirst = true;
                return false;
              }
              return true;
            })
          : historyEvents;

        // Limit catchup size for very long sessions. Older events are
        // available via the REST history API (/api/sessions/:id/history).
        const historyTruncated = filtered.length > MAX_CATCHUP_EVENTS;
        if (historyTruncated) {
          filtered = filtered.slice(filtered.length - MAX_CATCHUP_EVENTS);
        }

        log.info(
          {
            sessionId,
            eventCount: filtered.length,
            skippedInitialPrompt: skippedFirst,
            truncated: historyTruncated,
            totalEvents: historyEvents.length,
          },
          'CLI-native history reconstruction used for catchup',
        );
        let seq = lastEventId + 1;
        // Emit a system:info marker so the UI knows the source
        const sourceMsg = historyTruncated
          ? `History loaded from CLI native storage (showing last ${filtered.length} of ${historyEvents.length} events — scroll up to load more)`
          : `History loaded from CLI native storage (${filtered.length} events)`;
        const sourceEvent: AgendoEvent = {
          id: seq++,
          sessionId: session.id,
          ts: Date.now(),
          type: 'system:info',
          message: sourceMsg,
        };
        // Only send history marker + events if we actually have content.
        // After filtering (e.g. skipping initialPrompt), we might end up
        // with 0 events. In that case, fall through to the log file fallback.
        if (filtered.length > 0) {
          sendEvent(res, sourceEvent);
          for (const payload of filtered) {
            const event: AgendoEvent = {
              id: seq++,
              sessionId: session.id,
              ts: Date.now(),
              ...payload,
            } as AgendoEvent;
            sendEvent(res, event);
          }
          catchupSent = true;
        } else {
          log.info(
            { sessionId },
            'CLI-native history was empty after filtering, falling back to log',
          );
        }
      }
    } catch (err) {
      log.debug(
        { err, sessionId },
        'CLI-native history reconstruction failed, falling back to log',
      );
    }
  }

  // 2b. Live state from sources of truth (DB + filesystem).
  // CLI-native history only contains conversation content. Agendo-specific
  // state (session:init, team:*) lives in the DB and filesystem respectively.
  // Read from the actual sources rather than replaying stale log entries.
  if (proc) {
    const liveState = proc.getLiveState();
    if (liveState.length > 0) {
      let seq = catchupSent ? lastEventId + 1000 : lastEventId + 1;
      log.info(
        { sessionId, eventCount: liveState.length },
        'Supplementing catchup with live state (DB + filesystem)',
      );
      for (const payload of liveState) {
        const event: AgendoEvent = {
          id: seq++,
          sessionId: session.id,
          ts: Date.now(),
          ...payload,
        } as AgendoEvent;
        sendEvent(res, event);
      }
    }
  }

  // 2c. Log file fallback — used when CLI-native history didn't provide content.
  // This covers: ended sessions, agents without getHistory() support, worker
  // just restarted (session resumed but CLI history is minimal/empty),
  // or getHistory() returned only the initial prompt which was skipped.
  if (!catchupSent && session.logFilePath && existsSync(session.logFilePath)) {
    try {
      const logContent = readFileSync(session.logFilePath, 'utf-8');
      const allLogEvents = readEventsFromLog(logContent, lastEventId);
      // Filter out text/thinking deltas — they are ephemeral streaming fragments
      // that should not be replayed from the log. Replaying them causes all text
      // to appear instantly as a wall (no streaming effect) and can produce
      // duplicates when the complete text is reconstructed from accumulateHistory().
      const logEvents = allLogEvents.filter(
        (e) => e.type !== 'agent:text-delta' && e.type !== 'agent:thinking-delta',
      );
      if (logEvents.length > 0) {
        // Limit catchup for very long sessions — older events available via REST API
        const logTruncated = logEvents.length > MAX_CATCHUP_EVENTS;
        const limitedLogEvents = logTruncated
          ? logEvents.slice(logEvents.length - MAX_CATCHUP_EVENTS)
          : logEvents;
        const fallbackMsg = logTruncated
          ? `History loaded from log file (showing last ${limitedLogEvents.length} of ${logEvents.length} events — scroll up to load more)`
          : `History loaded from log file (${logEvents.length} events)`;
        const fallbackEvent: AgendoEvent = {
          id: 0,
          sessionId: session.id,
          ts: Date.now(),
          type: 'system:info',
          message: fallbackMsg,
        };
        sendEvent(res, fallbackEvent);
        for (const ev of limitedLogEvents) {
          sendEvent(res, ev);
        }
        catchupSent = true;
      }
    } catch {
      // Log file unreadable — no catchup available
    }
  }

  // Flush any events that arrived during the async history send, then switch
  // to direct mode so all subsequent events go straight to the client.
  for (const ev of buffered) {
    sendEvent(res, ev);
  }
  liveFlushing = true;
}

// ============================================================================
// Brainstorm SSE handler
// ============================================================================

/**
 * Handle a GET /brainstorms/:id/events request as an SSE stream.
 *
 * Flow:
 *   1. Send current room state and participant statuses from DB
 *   2. Replay historical events from log file (catchup)
 *   3. Register in-memory listener for live events
 *   4. Clean up on client disconnect
 */
export async function handleBrainstormSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roomId: string,
  lastEventId: number,
): Promise<void> {
  let room;
  try {
    room = await getBrainstorm(roomId);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'BrainstormRoom not found' }));
    return;
  }

  setSseHeaders(res);

  // Keepalive heartbeat to prevent proxy/browser timeout disconnects
  const heartbeatTimer = setInterval(() => sendHeartbeat(res), KEEPALIVE_INTERVAL_MS);

  // 1. Emit current room state immediately
  const roomStateEvent: BrainstormEvent = {
    id: 0,
    roomId: room.id,
    ts: Date.now(),
    type: 'room:state',
    status: room.status as BrainstormRoomStatus,
  };
  sendEvent(res, roomStateEvent);

  // 1b. Emit synthetic participant:status events so reconnecting clients see
  // accurate participant states. Same logic as the Next.js SSE route.
  for (const p of room.participants) {
    let eventStatus: 'thinking' | 'done' | 'passed' | 'timeout' | null = null;
    if (p.status === 'active') eventStatus = 'thinking';
    else if (p.status === 'passed') eventStatus = 'passed';

    if (eventStatus !== null) {
      const participantEvent: BrainstormEvent = {
        id: 0,
        roomId: roomId,
        ts: Date.now(),
        type: 'participant:status',
        participantId: p.id,
        agentId: p.agentId,
        agentName: p.agentName,
        agentSlug: p.agentSlug,
        status: eventStatus,
        model: p.model ?? null,
      };
      sendEvent(res, participantEvent);
    }
  }

  // 1c. Emit synthetic synthesis event if room already has one
  if (room.synthesis) {
    const synthesisEvent: BrainstormEvent = {
      id: 0,
      roomId: room.id,
      ts: Date.now(),
      type: 'room:synthesis',
      synthesis: room.synthesis,
    };
    sendEvent(res, synthesisEvent);
  }

  // 2. Register buffered listener BEFORE any I/O to avoid race condition.
  //    Live events emitted during the log read are buffered and flushed
  //    after catchup — mirrors the handleSessionSSE pattern.
  const buffered: BrainstormEvent[] = [];
  let liveFlushing = false;
  const unsub = addBrainstormEventListener(roomId, (event) => {
    if (liveFlushing) {
      sendEvent(res, event);
    } else {
      buffered.push(event);
    }
  });

  // 3. Clean up on client disconnect
  req.on('close', () => {
    clearInterval(heartbeatTimer);
    unsub();
    log.debug({ roomId }, 'Brainstorm SSE client disconnected');
  });

  // 4. Log file is the unconditional primary replay source.
  //    It contains ALL agents' messages (unlike in-memory session getHistory()
  //    which only returns data for the agent whose proc is live).
  if (room.logFilePath && existsSync(room.logFilePath)) {
    try {
      const logContent = readFileSync(room.logFilePath, 'utf-8');
      const catchupEvents = readBrainstormEventsFromLog(logContent, lastEventId);
      for (const ev of catchupEvents) {
        sendEvent(res, ev);
      }
    } catch {
      // Log file unreadable — no catchup, live events still work
    }
  }

  // 5. Flush buffered live events, then switch to direct mode.
  for (const ev of buffered) {
    sendEvent(res, ev);
  }
  liveFlushing = true;
}
