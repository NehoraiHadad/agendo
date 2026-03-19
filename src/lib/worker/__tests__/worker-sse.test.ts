/**
 * Tests for worker-sse.ts
 *
 * Covers:
 * - addSessionEventListener / addBrainstormEventListener registration and fan-out
 * - handleSessionSSE: SSE headers, state event, log catchup, live events, disconnect cleanup
 * - handleBrainstormSSE: same pattern for brainstorms
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AgendoEvent, BrainstormEvent } from '@/lib/realtime/event-types';

// ---------------------------------------------------------------------------
// Mock: session-service
// ---------------------------------------------------------------------------

const { mockGetSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
}));

vi.mock('@/lib/services/session-service', () => ({
  getSession: mockGetSession,
}));

// ---------------------------------------------------------------------------
// Mock: brainstorm-service
// ---------------------------------------------------------------------------

const { mockGetBrainstorm } = vi.hoisted(() => ({
  mockGetBrainstorm: vi.fn(),
}));

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
}));

// ---------------------------------------------------------------------------
// Mock: node:fs (for log file reads)
// ---------------------------------------------------------------------------

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockReadFileSync: vi.fn().mockReturnValue(''),
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

// ---------------------------------------------------------------------------
// Mock: session-runner (for getSessionProc fallback)
// ---------------------------------------------------------------------------

const { mockGetSessionProc } = vi.hoisted(() => ({
  mockGetSessionProc: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@/lib/worker/session-runner', () => ({
  getSessionProc: mockGetSessionProc,
}));

// ---------------------------------------------------------------------------
// Mock: brainstorm-history (keep buildTranscriptFromSessions available,
//       but getBrainstormHistoryFromSessions should NOT be called in the
//       fixed code — mock it to throw so tests catch any accidental calls)
// ---------------------------------------------------------------------------

const { mockGetBrainstormHistoryFromSessions } = vi.hoisted(() => ({
  mockGetBrainstormHistoryFromSessions: vi.fn(),
}));

vi.mock('@/lib/worker/brainstorm-history', () => ({
  getBrainstormHistoryFromSessions: mockGetBrainstormHistoryFromSessions,
  buildTranscriptFromSessions: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import {
  sessionEventListeners,
  brainstormEventListeners,
  addSessionEventListener,
  addBrainstormEventListener,
  handleSessionSSE,
  handleBrainstormSSE,
} from '../worker-sse';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock ServerResponse that captures writes */
function makeMockRes(): {
  res: http.ServerResponse;
  writtenHeaders: Array<{ statusCode: number; headers: Record<string, string> }>;
  writtenData: string[];
  ended: boolean;
} {
  const writtenHeaders: Array<{ statusCode: number; headers: Record<string, string> }> = [];
  const writtenData: string[] = [];
  let ended = false;
  let headersSent = false;

  const res = {
    headersSent: false,
    writeHead(statusCode: number, headers: Record<string, string>) {
      writtenHeaders.push({ statusCode, headers });
      headersSent = true;
      (this as unknown as { headersSent: boolean }).headersSent = headersSent;
    },
    write(data: string) {
      writtenData.push(data);
      return true;
    },
    end(data?: string) {
      if (data) writtenData.push(data);
      ended = true;
    },
    flushHeaders() {
      // no-op in test
    },
  } as unknown as http.ServerResponse;

  return { res, writtenHeaders, writtenData, ended };
}

/** Create a minimal mock IncomingMessage with a close event emitter */
function makeMockReq(url = '/'): {
  req: http.IncomingMessage;
  triggerClose: () => void;
} {
  const closeHandlers: Array<() => void> = [];
  const req = {
    url,
    headers: {},
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
    },
  } as unknown as http.IncomingMessage;

  return {
    req,
    triggerClose: () => closeHandlers.forEach((h) => h()),
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  sessionEventListeners.clear();
  brainstormEventListeners.clear();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
  // After the fix, getBrainstormHistoryFromSessions is NOT called from the SSE
  // path. Default to throwing so tests catch any accidental invocation.
  mockGetBrainstormHistoryFromSessions.mockRejectedValue(
    new Error('getBrainstormHistoryFromSessions should not be called from SSE path'),
  );
});

// ---------------------------------------------------------------------------
// addSessionEventListener
// ---------------------------------------------------------------------------

describe('addSessionEventListener', () => {
  it('registers a listener and fires it when events arrive', () => {
    const received: AgendoEvent[] = [];
    addSessionEventListener('session-1', (e) => received.push(e));

    const event: AgendoEvent = {
      id: 1,
      sessionId: 'session-1',
      ts: Date.now(),
      type: 'session:state',
      status: 'active',
    };
    const listeners = sessionEventListeners.get('session-1')!;
    expect(listeners.size).toBe(1);
    for (const cb of listeners) cb(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it('supports multiple listeners for the same sessionId', () => {
    const received1: AgendoEvent[] = [];
    const received2: AgendoEvent[] = [];
    addSessionEventListener('session-2', (e) => received1.push(e));
    addSessionEventListener('session-2', (e) => received2.push(e));

    const listeners = sessionEventListeners.get('session-2')!;
    expect(listeners.size).toBe(2);

    const event: AgendoEvent = {
      id: 1,
      sessionId: 'session-2',
      ts: 0,
      type: 'session:state',
      status: 'idle',
    };
    for (const cb of listeners) cb(event);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it('removes the listener when unsubscribe is called', () => {
    const received: AgendoEvent[] = [];
    const unsub = addSessionEventListener('session-3', (e) => received.push(e));

    unsub();

    const listeners = sessionEventListeners.get('session-3');
    expect(listeners).toBeUndefined(); // cleaned up when empty
  });

  it('cleans up the sessionId entry when last listener unsubscribes', () => {
    const unsub1 = addSessionEventListener('session-4', () => {});
    const unsub2 = addSessionEventListener('session-4', () => {});

    unsub1();
    expect(sessionEventListeners.has('session-4')).toBe(true); // still one listener

    unsub2();
    expect(sessionEventListeners.has('session-4')).toBe(false); // cleaned up
  });
});

// ---------------------------------------------------------------------------
// addBrainstormEventListener
// ---------------------------------------------------------------------------

describe('addBrainstormEventListener', () => {
  it('registers a listener and fires it when events arrive', () => {
    const received: BrainstormEvent[] = [];
    addBrainstormEventListener('room-1', (e) => received.push(e));

    const event: BrainstormEvent = {
      id: 1,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'room:state',
      status: 'active',
    };
    const listeners = brainstormEventListeners.get('room-1')!;
    for (const cb of listeners) cb(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it('removes the listener when unsubscribe is called', () => {
    const unsub = addBrainstormEventListener('room-2', () => {});
    unsub();
    expect(brainstormEventListeners.has('room-2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleSessionSSE
// ---------------------------------------------------------------------------

describe('handleSessionSSE', () => {
  it('returns 404 when session is not found', async () => {
    mockGetSession.mockRejectedValue(new Error('Not found'));
    const { req } = makeMockReq();
    const { res, writtenHeaders } = makeMockRes();

    await handleSessionSSE(req, res, 'nonexistent', 0);

    expect(writtenHeaders[0].statusCode).toBe(404);
  });

  it('sets SSE headers and sends session:state event on connect', async () => {
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      status: 'active',
      eventSeq: 5,
      logFilePath: null,
    });
    const { req } = makeMockReq();
    const { res, writtenHeaders, writtenData } = makeMockRes();

    await handleSessionSSE(req, res, 'sess-1', 0);

    // Check SSE headers
    const headers = writtenHeaders[0];
    expect(headers.statusCode).toBe(200);
    expect(headers.headers['Content-Type']).toBe('text/event-stream');

    // Check session:state event was sent
    expect(writtenData.length).toBeGreaterThan(0);
    const stateFrame = writtenData.find((d) => d.includes('session:state'));
    expect(stateFrame).toBeDefined();
    expect(stateFrame).toContain('"status":"active"');
  });

  it('replays events from log file after lastEventId', async () => {
    mockGetSession.mockResolvedValue({
      id: 'sess-2',
      status: 'awaiting_input',
      eventSeq: 10,
      logFilePath: '/logs/sess-2.log',
    });

    // Mock log file with 2 events
    mockExistsSync.mockReturnValue(true);
    const event1 = { id: 1, sessionId: 'sess-2', ts: 100, type: 'agent:text', text: 'hello' };
    const event2 = { id: 2, sessionId: 'sess-2', ts: 200, type: 'agent:text', text: 'world' };
    mockReadFileSync.mockReturnValue(
      `[system] [1|agent:text] ${JSON.stringify(event1)}\n[system] [2|agent:text] ${JSON.stringify(event2)}\n`,
    );

    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    await handleSessionSSE(req, res, 'sess-2', 0); // lastEventId=0, replay all

    // Should have state event + 2 log events
    const frames = writtenData.join('');
    expect(frames).toContain('session:state');
    expect(frames).toContain('hello');
    expect(frames).toContain('world');
  });

  it('sends live events to connected SSE streams', async () => {
    mockGetSession.mockResolvedValue({
      id: 'sess-3',
      status: 'active',
      eventSeq: 0,
      logFilePath: null,
    });
    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    await handleSessionSSE(req, res, 'sess-3', 0);

    // Simulate a live event arriving
    const liveEvent: AgendoEvent = {
      id: 1,
      sessionId: 'sess-3',
      ts: Date.now(),
      type: 'agent:text',
      text: 'live text',
    };
    const listeners = sessionEventListeners.get('sess-3')!;
    for (const cb of listeners) cb(liveEvent);

    const allData = writtenData.join('');
    expect(allData).toContain('live text');
  });

  it('removes listener and cleans up session entry on disconnect', async () => {
    mockGetSession.mockResolvedValue({
      id: 'sess-4',
      status: 'idle',
      eventSeq: 0,
      logFilePath: null,
    });
    const { req, triggerClose } = makeMockReq();
    const { res } = makeMockRes();

    await handleSessionSSE(req, res, 'sess-4', 0);

    expect(sessionEventListeners.has('sess-4')).toBe(true);

    triggerClose(); // simulate client disconnect

    expect(sessionEventListeners.has('sess-4')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleBrainstormSSE
// ---------------------------------------------------------------------------

describe('handleBrainstormSSE', () => {
  it('returns 404 when room is not found', async () => {
    mockGetBrainstorm.mockRejectedValue(new Error('Not found'));
    const { req } = makeMockReq();
    const { res, writtenHeaders } = makeMockRes();

    await handleBrainstormSSE(req, res, 'nonexistent', 0);

    expect(writtenHeaders[0].statusCode).toBe(404);
  });

  it('sets SSE headers and sends room:state event on connect', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-1',
      status: 'active',
      logFilePath: null,
      participants: [],
    });
    const { req } = makeMockReq();
    const { res, writtenHeaders, writtenData } = makeMockRes();

    await handleBrainstormSSE(req, res, 'room-1', 0);

    const headers = writtenHeaders[0];
    expect(headers.statusCode).toBe(200);
    expect(headers.headers['Content-Type']).toBe('text/event-stream');

    const allData = writtenData.join('');
    expect(allData).toContain('room:state');
    expect(allData).toContain('"active"');
  });

  it('sends participant:status events for active and passed participants', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-2',
      status: 'active',
      logFilePath: null,
      participants: [
        { agentId: 'agent-1', agentName: 'Alice', status: 'active' },
        { agentId: 'agent-2', agentName: 'Bob', status: 'passed' },
        { agentId: 'agent-3', agentName: 'Charlie', status: 'pending' }, // skipped
      ],
    });
    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    await handleBrainstormSSE(req, res, 'room-2', 0);

    const allData = writtenData.join('');
    expect(allData).toContain('participant:status');
    expect(allData).toContain('"thinking"'); // active → thinking
    expect(allData).toContain('"passed"'); // passed → passed
    // Charlie (pending) should NOT generate a participant:status event
    expect(allData.match(/"agentName":"Charlie"/g) ?? []).toHaveLength(0);
  });

  it('removes listener on disconnect', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-3',
      status: 'waiting',
      logFilePath: null,
      participants: [],
    });
    const { req, triggerClose } = makeMockReq();
    const { res } = makeMockRes();

    await handleBrainstormSSE(req, res, 'room-3', 0);

    expect(brainstormEventListeners.has('room-3')).toBe(true);

    triggerClose();

    expect(brainstormEventListeners.has('room-3')).toBe(false);
  });

  it('sends live events to connected streams', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-4',
      status: 'active',
      logFilePath: null,
      participants: [],
    });
    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    await handleBrainstormSSE(req, res, 'room-4', 0);

    const liveEvent: BrainstormEvent = {
      id: 1,
      roomId: 'room-4',
      ts: Date.now(),
      type: 'wave:start',
      wave: 1,
    };
    const listeners = brainstormEventListeners.get('room-4')!;
    for (const cb of listeners) cb(liveEvent);

    expect(writtenData.join('')).toContain('wave:start');
  });

  it('emits synthetic room:synthesis event when room has a stored synthesis', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-5',
      status: 'ended',
      synthesis: 'The team concluded that approach A is best.',
      logFilePath: null,
      participants: [],
    });
    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    await handleBrainstormSSE(req, res, 'room-5', 0);

    const allData = writtenData.join('');
    expect(allData).toContain('room:synthesis');
    expect(allData).toContain('The team concluded that approach A is best.');
  });

  // -------------------------------------------------------------------------
  // NEW TESTS: log-file-first replay (the fixed behavior)
  // -------------------------------------------------------------------------

  it('log file replays ALL agents — both Claude and Gemini messages appear on cold connect', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-log-1',
      status: 'ended',
      synthesis: null,
      logFilePath: '/logs/room-log-1.log',
      participants: [
        { agentId: 'agent-claude', agentName: 'Claude', status: 'done' },
        { agentId: 'agent-gemini', agentName: 'Gemini', status: 'done' },
      ],
    });

    mockExistsSync.mockReturnValue(true);
    const claudeEvent = {
      id: 1,
      roomId: 'room-log-1',
      ts: 100,
      type: 'message',
      wave: 0,
      senderType: 'agent',
      agentId: 'agent-claude',
      agentName: 'Claude',
      content: 'Claude says hello',
      isPass: false,
    };
    const geminiEvent = {
      id: 2,
      roomId: 'room-log-1',
      ts: 200,
      type: 'message',
      wave: 0,
      senderType: 'agent',
      agentId: 'agent-gemini',
      agentName: 'Gemini',
      content: 'Gemini says hi',
      isPass: false,
    };
    mockReadFileSync.mockReturnValue(
      `[system] [1|message] ${JSON.stringify(claudeEvent)}\n` +
        `[system] [2|message] ${JSON.stringify(geminiEvent)}\n`,
    );

    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    await handleBrainstormSSE(req, res, 'room-log-1', 0);

    const allData = writtenData.join('');
    expect(allData).toContain('Claude says hello');
    expect(allData).toContain('Gemini says hi');
    // Should NOT call getBrainstormHistoryFromSessions
    expect(mockGetBrainstormHistoryFromSessions).not.toHaveBeenCalled();
  });

  it('lastEventId filtering: only replays events after the given lastEventId', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-log-2',
      status: 'ended',
      synthesis: null,
      logFilePath: '/logs/room-log-2.log',
      participants: [],
    });

    mockExistsSync.mockReturnValue(true);
    // Build 10 events with IDs 1–10
    const logLines = Array.from({ length: 10 }, (_, i) => {
      const ev = {
        id: i + 1,
        roomId: 'room-log-2',
        ts: 100 + i,
        type: 'message',
        wave: 0,
        senderType: 'agent',
        agentId: 'agent-1',
        agentName: 'Agent',
        content: `message ${i + 1}`,
        isPass: false,
      };
      return `[system] [${i + 1}|message] ${JSON.stringify(ev)}`;
    }).join('\n');
    mockReadFileSync.mockReturnValue(logLines);

    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    // Reconnect with lastEventId=5 — should only replay events 6–10
    await handleBrainstormSSE(req, res, 'room-log-2', 5);

    const allData = writtenData.join('');
    // Events 1–5 must NOT appear
    for (let i = 1; i <= 5; i++) {
      expect(allData).not.toContain(`"content":"message ${i}"`);
    }
    // Events 6–10 MUST appear
    for (let i = 6; i <= 10; i++) {
      expect(allData).toContain(`"content":"message ${i}"`);
    }
  });

  it('unreadable log file does not crash — function completes normally', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-log-3',
      status: 'active',
      synthesis: null,
      logFilePath: '/logs/room-log-3.log',
      participants: [],
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    // Should not throw
    await expect(handleBrainstormSSE(req, res, 'room-log-3', 0)).resolves.toBeUndefined();

    // room:state still sent
    const allData = writtenData.join('');
    expect(allData).toContain('room:state');
  });

  it('does not emit room:synthesis event when synthesis is null', async () => {
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-6',
      status: 'ended',
      synthesis: null,
      logFilePath: null,
      participants: [],
    });
    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    await handleBrainstormSSE(req, res, 'room-6', 0);

    const allData = writtenData.join('');
    expect(allData).not.toContain('room:synthesis');
  });

  it('emits synthesis event before log catchup so it is not duplicated', async () => {
    // The synthetic event is sent before log replay. Verify ordering: room:state,
    // then room:synthesis, then any log events.
    mockGetBrainstorm.mockResolvedValue({
      id: 'room-7',
      status: 'ended',
      synthesis: 'Synthesis content',
      logFilePath: '/logs/room-7.log',
      participants: [],
    });

    mockExistsSync.mockReturnValue(true);
    const logEvent = {
      id: 1,
      roomId: 'room-7',
      ts: 100,
      type: 'wave:start',
      wave: 1,
    };
    mockReadFileSync.mockReturnValue(`[system] [1|wave:start] ${JSON.stringify(logEvent)}\n`);

    const { req } = makeMockReq();
    const { res, writtenData } = makeMockRes();

    await handleBrainstormSSE(req, res, 'room-7', 0);

    const allData = writtenData.join('');
    const synthesisPos = allData.indexOf('room:synthesis');
    const wavePos = allData.indexOf('wave:start');

    expect(synthesisPos).toBeGreaterThan(-1);
    expect(wavePos).toBeGreaterThan(-1);
    // Synthesis synthetic event appears before log events
    expect(synthesisPos).toBeLessThan(wavePos);
  });
});
