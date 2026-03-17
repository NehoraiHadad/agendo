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
 * CLI-native history (adapter.getHistory()) is the primary source for SSE
 * reconnect catchup. Log files serve as fallback and audit trail.
 */

import * as http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '@/lib/logger';
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

// ============================================================================
// Shared in-memory listener registries
// ============================================================================

/**
 * Live SSE listeners for session events. Keyed by sessionId.
 * Populated by handleSessionSSE; consumed by SessionProcess.emitEvent().
 */
export const sessionEventListeners = new Map<string, Set<(event: AgendoEvent) => void>>();

/**
 * Live SSE listeners for brainstorm events. Keyed by roomId.
 * Populated by handleBrainstormSSE; consumed by BrainstormOrchestrator.emitEvent().
 */
export const brainstormEventListeners = new Map<string, Set<(event: BrainstormEvent) => void>>();

// ============================================================================
// Listener registration helpers
// ============================================================================

/**
 * Register a session event listener.
 * Returns an unsubscribe function that removes the listener.
 */
export function addSessionEventListener(
  sessionId: string,
  cb: (event: AgendoEvent) => void,
): () => void {
  let listeners = sessionEventListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    sessionEventListeners.set(sessionId, listeners);
  }
  listeners.add(cb);

  return () => {
    const current = sessionEventListeners.get(sessionId);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) {
      sessionEventListeners.delete(sessionId);
    }
  };
}

/**
 * Register a brainstorm event listener.
 * Returns an unsubscribe function that removes the listener.
 */
export function addBrainstormEventListener(
  roomId: string,
  cb: (event: BrainstormEvent) => void,
): () => void {
  let listeners = brainstormEventListeners.get(roomId);
  if (!listeners) {
    listeners = new Set();
    brainstormEventListeners.set(roomId, listeners);
  }
  listeners.add(cb);

  return () => {
    const current = brainstormEventListeners.get(roomId);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) {
      brainstormEventListeners.delete(roomId);
    }
  };
}

// ============================================================================
// SSE helpers
// ============================================================================

function setSseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
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

  // 2. Catchup: reconstruct conversation history for the reconnecting browser.
  //
  //    Priority order:
  //      (a) CLI-native history via adapter.getHistory() — the authoritative
  //          source of conversation content. Reads directly from the CLI's own
  //          storage (Claude JSONL, Codex thread/read).
  //      (b) Log file — fallback for agents without getHistory() support
  //          (Gemini, Copilot), for ended sessions with no live process, or
  //          when getHistory() fails.
  //
  //    The log file is an audit trail / write-ahead log. It captures
  //    Agendo-specific events (approvals, team messages, state transitions)
  //    that CLI-native history doesn't have, but the core conversation
  //    content comes from the CLI.
  let catchupSent = false;

  // 2a. Try CLI-native history first (requires a live SessionProcess)
  // Skip on reconnect (lastEventId > 0) — client already has conversation history.
  // Re-sending CLI-native history with new sequential IDs causes message duplication
  // because the client deduplicates by event ID only.
  const proc = getSessionProc(sessionId);
  if (proc && lastEventId === 0) {
    try {
      const historyEvents = await proc.getHistory();
      if (historyEvents && historyEvents.length > 0) {
        log.info(
          { sessionId, eventCount: historyEvents.length },
          'CLI-native history reconstruction used for catchup',
        );
        let seq = lastEventId + 1;
        // Emit a system:info marker so the UI knows the source
        const sourceEvent: AgendoEvent = {
          id: seq++,
          sessionId: session.id,
          ts: Date.now(),
          type: 'system:info',
          message: `History loaded from CLI native storage (${historyEvents.length} events)`,
        };
        sendEvent(res, sourceEvent);
        for (const payload of historyEvents) {
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

  // 2b. Fallback to log file when CLI-native history is unavailable
  if (!catchupSent && session.logFilePath && existsSync(session.logFilePath)) {
    try {
      const logContent = readFileSync(session.logFilePath, 'utf-8');
      const catchupEvents = readEventsFromLog(logContent, lastEventId);
      if (catchupEvents.length > 0) {
        // Emit a system:info marker so the UI knows the source
        const fallbackEvent: AgendoEvent = {
          id: 0,
          sessionId: session.id,
          ts: Date.now(),
          type: 'system:info',
          message: `History loaded from log file (${catchupEvents.length} events)`,
        };
        sendEvent(res, fallbackEvent);
        for (const ev of catchupEvents) {
          sendEvent(res, ev);
        }
        catchupSent = true;
      }
    } catch {
      // Log file unreadable — no catchup available
    }
  }

  // 3. Register in-memory listener for live events
  const unsub = addSessionEventListener(sessionId, (event) => {
    sendEvent(res, event);
  });

  // 4. Clean up on client disconnect
  req.on('close', () => {
    unsub();
    log.debug({ sessionId }, 'SSE client disconnected');
  });
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

  // 2. Catchup: replay historical events from log file
  if (room.logFilePath && existsSync(room.logFilePath)) {
    try {
      const logContent = readFileSync(room.logFilePath, 'utf-8');
      const catchupEvents = readBrainstormEventsFromLog(logContent, lastEventId);
      for (const ev of catchupEvents) {
        sendEvent(res, ev);
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
