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
import { getBrainstormHistoryFromSessions } from '@/lib/worker/brainstorm-history';
import type {
  AgendoEvent,
  BrainstormEvent,
  SessionStatus,
  BrainstormRoomStatus,
} from '@/lib/realtime/event-types';

const log = createLogger('worker-sse');

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

  // 4. Clean up on client disconnect
  req.on('close', () => {
    unsub();
    log.debug({ sessionId }, 'SSE client disconnected');
  });

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
        const filtered = session.initialPrompt
          ? historyEvents.filter((ev) => {
              if (!skippedFirst && ev.type === 'user:message') {
                skippedFirst = true;
                return false;
              }
              return true;
            })
          : historyEvents;

        log.info(
          { sessionId, eventCount: filtered.length, skippedInitialPrompt: skippedFirst },
          'CLI-native history reconstruction used for catchup',
        );
        let seq = lastEventId + 1;
        // Emit a system:info marker so the UI knows the source
        const sourceEvent: AgendoEvent = {
          id: seq++,
          sessionId: session.id,
          ts: Date.now(),
          type: 'system:info',
          message: `History loaded from CLI native storage (${filtered.length} events)`,
        };
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

  // 2c. Log file fallback — only when no live process is available (ended
  // sessions, agents without getHistory() support, worker just restarted).
  if (!catchupSent && !proc && session.logFilePath && existsSync(session.logFilePath)) {
    try {
      const logContent = readFileSync(session.logFilePath, 'utf-8');
      const logEvents = readEventsFromLog(logContent, lastEventId);
      if (logEvents.length > 0) {
        const fallbackEvent: AgendoEvent = {
          id: 0,
          sessionId: session.id,
          ts: Date.now(),
          type: 'system:info',
          message: `History loaded from log file (${logEvents.length} events)`,
        };
        sendEvent(res, fallbackEvent);
        for (const ev of logEvents) {
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
        agentId: p.agentId,
        agentName: p.agentName,
        status: eventStatus,
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

  // 2. Catchup: participant getHistory() (primary) → log file (fallback)
  //
  //    Priority order:
  //      (a) Participant session getHistory() — the authoritative source.
  //          Calls each participant's live SessionProcess.getHistory(), which
  //          delegates to the adapter (Claude JSONL, Codex thread/read, etc.)
  //          and maps agent:text turns to brainstorm message events by wave.
  //      (b) Log file — fallback when no live procs are available (e.g. ended
  //          brainstorms with Gemini/Copilot participants, or after worker restart).
  let catchupSent = false;

  if (lastEventId === 0) {
    try {
      const historyEvents = await getBrainstormHistoryFromSessions(room);
      if (historyEvents.length > 0) {
        log.info(
          { roomId, eventCount: historyEvents.length },
          'Brainstorm catchup from participant session histories',
        );
        for (const ev of historyEvents) {
          sendEvent(res, ev);
        }
        catchupSent = true;
      }
    } catch (err) {
      log.debug({ err, roomId }, 'Participant history catchup failed, falling back to log');
    }
  }

  if (!catchupSent && room.logFilePath && existsSync(room.logFilePath)) {
    try {
      const logContent = readFileSync(room.logFilePath, 'utf-8');
      const catchupEvents = readBrainstormEventsFromLog(logContent, lastEventId);
      if (catchupEvents.length > 0) {
        for (const ev of catchupEvents) {
          sendEvent(res, ev);
        }
      }
    } catch {
      // Log file unreadable — skip catchup
    }
  }

  // 3. Register in-memory listener for live events
  const unsub = addBrainstormEventListener(roomId, (event) => {
    sendEvent(res, event);
  });

  // 4. Clean up on client disconnect
  req.on('close', () => {
    unsub();
    log.debug({ roomId }, 'Brainstorm SSE client disconnected');
  });
}
