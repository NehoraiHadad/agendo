/**
 * Brainstorm room-1 event arc — "Design session reconnect strategy"
 *
 * Room ID: eeeeeeee-eeee-4001-e001-eeeeeeeeeeee
 * Three participants: Claude (architect), Codex (critic), Gemini (pragmatist)
 * Three waves over ~60 seconds of replay time.
 *
 * Wave 1 (~1–13s): initial positions
 * Wave 2 (~14–28s): cross-critique
 * Wave 3 (~29–54s): synthesis
 *
 * Total events: ~80-120
 */

import type { BrainstormEventPayload } from '@/lib/realtime/event-types';
import {
  DEMO_BRAINSTORM_ROOM_ID,
  DEMO_PARTICIPANT_CLAUDE_ID,
  DEMO_PARTICIPANT_CODEX_ID,
  DEMO_PARTICIPANT_GEMINI_ID,
} from '@/lib/services/brainstorm-service.demo';

// ---------------------------------------------------------------------------
// Replayable event type for brainstorm arcs
// (Separate from factories.ts ReplayableEvent — brainstorm events use roomId,
//  not sessionId, and a different discriminated union.)
// ---------------------------------------------------------------------------

export interface BrainstormReplayableEvent {
  /** Milliseconds from the start of the replay at which this event fires. */
  atMs: number;
  /** Brainstorm room this event belongs to. */
  roomId: string;
  /** Discriminant — mirrors BrainstormEvent['type']. */
  type: BrainstormEventPayload['type'];
  /** Event payload (all fields except id, roomId, ts). */
  payload: BrainstormEventPayload;
}

// ---------------------------------------------------------------------------
// Agent / participant IDs (from brainstorm-service.demo.ts)
// ---------------------------------------------------------------------------

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';
const GEMINI_AGENT_ID = '33333333-3333-4333-a333-333333333333';

const ROOM_ID = DEMO_BRAINSTORM_ROOM_ID;

const P_CLAUDE = DEMO_PARTICIPANT_CLAUDE_ID;
const P_CODEX = DEMO_PARTICIPANT_CODEX_ID;
const P_GEMINI = DEMO_PARTICIPANT_GEMINI_ID;

// ---------------------------------------------------------------------------
// Deterministic jitter (±10ms) — seeded from roomId + index
// ---------------------------------------------------------------------------

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0xdeadbeef;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function seedFromId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

const _roomSeed = seedFromId(ROOM_ID);

function jitter(atMs: number, index: number): number {
  const seed = (_roomSeed ^ (index * 0x9e3779b9)) >>> 0;
  const rng = xorshift32(seed);
  const delta = Math.round((rng() - 0.5) * 20); // ±10ms
  return Math.max(0, atMs + delta);
}

// ---------------------------------------------------------------------------
// Event builder helpers (imperative, appending to an array)
// ---------------------------------------------------------------------------

function makeRoomState(
  status: Extract<BrainstormEventPayload, { type: 'room:state' }>['status'],
  atMs: number,
  index: number,
): BrainstormReplayableEvent {
  return {
    atMs: jitter(atMs, index),
    roomId: ROOM_ID,
    type: 'room:state',
    payload: { type: 'room:state', status },
  };
}

function makeWaveStart(wave: number, atMs: number, index: number): BrainstormReplayableEvent {
  return {
    atMs: jitter(atMs, index),
    roomId: ROOM_ID,
    type: 'wave:start',
    payload: { type: 'wave:start', wave },
  };
}

function makeWaveComplete(wave: number, atMs: number, index: number): BrainstormReplayableEvent {
  return {
    atMs: jitter(atMs, index),
    roomId: ROOM_ID,
    type: 'wave:complete',
    payload: { type: 'wave:complete', wave },
  };
}

function makeParticipantJoined(
  participantId: string,
  agentId: string,
  agentName: string,
  agentSlug: string,
  role: string,
  model: string,
  atMs: number,
  index: number,
): BrainstormReplayableEvent {
  return {
    atMs: jitter(atMs, index),
    roomId: ROOM_ID,
    type: 'participant:joined',
    payload: {
      type: 'participant:joined',
      participantId,
      agentId,
      agentName,
      agentSlug,
      role,
      model,
      recovery: null,
    },
  };
}

function makeParticipantStatus(
  participantId: string,
  agentId: string,
  agentName: string,
  agentSlug: string,
  status: Extract<BrainstormEventPayload, { type: 'participant:status' }>['status'],
  atMs: number,
  index: number,
): BrainstormReplayableEvent {
  return {
    atMs: jitter(atMs, index),
    roomId: ROOM_ID,
    type: 'participant:status',
    payload: {
      type: 'participant:status',
      participantId,
      agentId,
      agentName,
      agentSlug,
      status,
      error: null,
      model: null,
      recovery: null,
    },
  };
}

function makeMessage(
  participantId: string,
  agentId: string,
  agentName: string,
  content: string,
  wave: number,
  isPass: boolean,
  atMs: number,
  index: number,
): BrainstormReplayableEvent {
  return {
    atMs: jitter(atMs, index),
    roomId: ROOM_ID,
    type: 'message',
    payload: {
      type: 'message',
      wave,
      senderType: 'agent',
      participantId,
      agentId,
      agentName,
      content,
      isPass,
    },
  };
}

/**
 * Splits fullText into groups of `tokensPerChunk` words and emits message:delta
 * events spread linearly from startMs to startMs + totalDurationMs.
 *
 * We group words together (default 4 per chunk) to keep delta count manageable.
 */
function makeStreamedDeltas(
  participantId: string,
  agentId: string,
  fullText: string,
  startMs: number,
  totalDurationMs: number,
  indexStart: number,
  tokensPerChunk = 4,
): BrainstormReplayableEvent[] {
  const rawTokens = fullText.split(/(\s+)/);
  // Combine into word+space pairs
  const wordPairs: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 2) {
    const word = rawTokens[i] ?? '';
    const space = rawTokens[i + 1] ?? '';
    if (word.length > 0 || space.length > 0) {
      wordPairs.push(word + space);
    }
  }

  // Group tokensPerChunk word-pairs into a single delta
  const chunks: string[] = [];
  for (let i = 0; i < wordPairs.length; i += tokensPerChunk) {
    chunks.push(wordPairs.slice(i, i + tokensPerChunk).join(''));
  }

  if (chunks.length === 0) return [];

  const intervalMs = totalDurationMs / chunks.length;
  return chunks.map((chunk, i): BrainstormReplayableEvent => {
    const atMs = Math.max(0, startMs + Math.round(i * intervalMs));
    return {
      atMs: jitter(atMs, indexStart + i),
      roomId: ROOM_ID,
      type: 'message:delta',
      payload: {
        type: 'message:delta',
        participantId,
        agentId,
        text: chunk,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Message content
// ---------------------------------------------------------------------------

const WAVE1_CLAUDE =
  'Use `lastEventId` from the SSE spec with a per-connection cursor. ' +
  'Simple and standards-based — every browser EventSource tracks this automatically.';

const WAVE1_CODEX =
  'Need to handle server restarts — event IDs reset after each deploy. ' +
  'Add an epoch number so lastEventId stays unique across restarts.';

const WAVE1_GEMINI =
  'Both miss the client side: during disconnection the client loses its local event window. ' +
  'Need client-local retention — a ring buffer prevents losing events on reconnect.';

const WAVE2_CLAUDE =
  'Good point on epoch. Revising: lastEventId as `{ epoch, seq }` tuple. ' +
  'Epoch increments on each worker restart so the server can detect cross-restart reconnects.';

const WAVE2_CODEX =
  'Client retention is right — add an IndexedDB window of last 500 events. ' +
  'Replay fills the server gap; IndexedDB fills any gap the server window misses.';

const WAVE2_GEMINI =
  'If epoch bumps, the server should return a `sessionReset` event so the client ' +
  'drops its stale cursor and IndexedDB state from the previous epoch.';

const SYNTHESIS_TEXT =
  'Hybrid approach — client maintains IndexedDB window of last 500 events; server uses ' +
  '`{epoch, seq}` cursor; catchup endpoint supports a `from` param as an opaque JSON token. ' +
  'On epoch change, server emits `sessionReset` signaling client to drop its window and reset ' +
  'its cursor. This eliminates lost-event windows across both network drops and server restarts.';

// ---------------------------------------------------------------------------
// Arc assembly — imperative push so index counter stays correct
// ---------------------------------------------------------------------------

function buildArc(): BrainstormReplayableEvent[] {
  const events: BrainstormReplayableEvent[] = [];
  let i = 0; // monotonic index for jitter seeding

  // ── Setup (t=0) ──────────────────────────────────────────────────────────

  events.push(makeRoomState('active', 0, i++));
  events.push({
    atMs: jitter(50, i++),
    roomId: ROOM_ID,
    type: 'room:config',
    payload: { type: 'room:config', maxWaves: 10 },
  });

  // Participants join
  events.push(
    makeParticipantJoined(
      P_CLAUDE,
      CLAUDE_AGENT_ID,
      'Claude Code',
      'claude-code',
      'architect',
      'claude-opus-4-5-20250514',
      200,
      i++,
    ),
  );
  events.push(
    makeParticipantJoined(
      P_CODEX,
      CODEX_AGENT_ID,
      'Codex CLI',
      'codex-cli',
      'critic',
      'codex-1',
      350,
      i++,
    ),
  );
  events.push(
    makeParticipantJoined(
      P_GEMINI,
      GEMINI_AGENT_ID,
      'Gemini CLI',
      'gemini-cli',
      'pragmatist',
      'gemini-2.5-pro',
      500,
      i++,
    ),
  );

  // ── Wave 1 — initial positions (t=1000–13000) ─────────────────────────────

  events.push(makeWaveStart(1, 1000, i++));
  events.push(
    makeParticipantStatus(
      P_CLAUDE,
      CLAUDE_AGENT_ID,
      'Claude Code',
      'claude-code',
      'thinking',
      1200,
      i++,
    ),
  );
  events.push(
    makeParticipantStatus(P_CODEX, CODEX_AGENT_ID, 'Codex CLI', 'codex-cli', 'thinking', 1300, i++),
  );
  events.push(
    makeParticipantStatus(
      P_GEMINI,
      GEMINI_AGENT_ID,
      'Gemini CLI',
      'gemini-cli',
      'thinking',
      1400,
      i++,
    ),
  );

  // Claude streams and completes (t=2000–5000)
  const claudeW1Deltas = makeStreamedDeltas(P_CLAUDE, CLAUDE_AGENT_ID, WAVE1_CLAUDE, 2000, 3000, i);
  i += claudeW1Deltas.length;
  events.push(...claudeW1Deltas);
  events.push(
    makeMessage(P_CLAUDE, CLAUDE_AGENT_ID, 'Claude Code', WAVE1_CLAUDE, 1, false, 5100, i++),
  );
  events.push(
    makeParticipantStatus(
      P_CLAUDE,
      CLAUDE_AGENT_ID,
      'Claude Code',
      'claude-code',
      'done',
      5200,
      i++,
    ),
  );

  // Codex streams and completes (t=4000–8000)
  const codexW1Deltas = makeStreamedDeltas(P_CODEX, CODEX_AGENT_ID, WAVE1_CODEX, 4000, 3500, i);
  i += codexW1Deltas.length;
  events.push(...codexW1Deltas);
  events.push(makeMessage(P_CODEX, CODEX_AGENT_ID, 'Codex CLI', WAVE1_CODEX, 1, false, 7600, i++));
  events.push(
    makeParticipantStatus(P_CODEX, CODEX_AGENT_ID, 'Codex CLI', 'codex-cli', 'done', 7700, i++),
  );

  // Gemini streams and completes (t=6000–11000)
  const geminiW1Deltas = makeStreamedDeltas(P_GEMINI, GEMINI_AGENT_ID, WAVE1_GEMINI, 6000, 4000, i);
  i += geminiW1Deltas.length;
  events.push(...geminiW1Deltas);
  events.push(
    makeMessage(P_GEMINI, GEMINI_AGENT_ID, 'Gemini CLI', WAVE1_GEMINI, 1, false, 10100, i++),
  );
  events.push(
    makeParticipantStatus(
      P_GEMINI,
      GEMINI_AGENT_ID,
      'Gemini CLI',
      'gemini-cli',
      'done',
      10200,
      i++,
    ),
  );

  events.push(makeWaveComplete(1, 11000, i++));

  // ── Wave 2 — cross-critique (t=12000–27000) ──────────────────────────────

  events.push(makeWaveStart(2, 12000, i++));
  events.push(
    makeParticipantStatus(
      P_CLAUDE,
      CLAUDE_AGENT_ID,
      'Claude Code',
      'claude-code',
      'thinking',
      12200,
      i++,
    ),
  );
  events.push(
    makeParticipantStatus(
      P_CODEX,
      CODEX_AGENT_ID,
      'Codex CLI',
      'codex-cli',
      'thinking',
      12300,
      i++,
    ),
  );
  events.push(
    makeParticipantStatus(
      P_GEMINI,
      GEMINI_AGENT_ID,
      'Gemini CLI',
      'gemini-cli',
      'thinking',
      12400,
      i++,
    ),
  );

  // Claude responds (t=13000–16500)
  const claudeW2Deltas = makeStreamedDeltas(
    P_CLAUDE,
    CLAUDE_AGENT_ID,
    WAVE2_CLAUDE,
    13000,
    3500,
    i,
  );
  i += claudeW2Deltas.length;
  events.push(...claudeW2Deltas);
  events.push(
    makeMessage(P_CLAUDE, CLAUDE_AGENT_ID, 'Claude Code', WAVE2_CLAUDE, 2, false, 16600, i++),
  );
  events.push(
    makeParticipantStatus(
      P_CLAUDE,
      CLAUDE_AGENT_ID,
      'Claude Code',
      'claude-code',
      'done',
      16700,
      i++,
    ),
  );

  // Codex responds (t=15000–19000)
  const codexW2Deltas = makeStreamedDeltas(P_CODEX, CODEX_AGENT_ID, WAVE2_CODEX, 15000, 4000, i);
  i += codexW2Deltas.length;
  events.push(...codexW2Deltas);
  events.push(makeMessage(P_CODEX, CODEX_AGENT_ID, 'Codex CLI', WAVE2_CODEX, 2, false, 19100, i++));
  events.push(
    makeParticipantStatus(P_CODEX, CODEX_AGENT_ID, 'Codex CLI', 'codex-cli', 'done', 19200, i++),
  );

  // Gemini responds (t=17000–21500)
  const geminiW2Deltas = makeStreamedDeltas(
    P_GEMINI,
    GEMINI_AGENT_ID,
    WAVE2_GEMINI,
    17000,
    4500,
    i,
  );
  i += geminiW2Deltas.length;
  events.push(...geminiW2Deltas);
  events.push(
    makeMessage(P_GEMINI, GEMINI_AGENT_ID, 'Gemini CLI', WAVE2_GEMINI, 2, false, 21600, i++),
  );
  events.push(
    makeParticipantStatus(
      P_GEMINI,
      GEMINI_AGENT_ID,
      'Gemini CLI',
      'gemini-cli',
      'done',
      21700,
      i++,
    ),
  );

  events.push(makeWaveComplete(2, 22500, i++));

  // ── Wave 3 — synthesis (t=23000–54000) ───────────────────────────────────

  events.push(makeWaveStart(3, 23000, i++));
  events.push(
    makeParticipantStatus(
      P_CLAUDE,
      CLAUDE_AGENT_ID,
      'Claude Code',
      'claude-code',
      'thinking',
      23200,
      i++,
    ),
  );

  // Codex and Gemini pass immediately (convergence)
  events.push(makeMessage(P_CODEX, CODEX_AGENT_ID, 'Codex CLI', 'pass', 3, true, 24000, i++));
  events.push(
    makeParticipantStatus(P_CODEX, CODEX_AGENT_ID, 'Codex CLI', 'codex-cli', 'passed', 24100, i++),
  );
  events.push(makeMessage(P_GEMINI, GEMINI_AGENT_ID, 'Gemini CLI', 'pass', 3, true, 24500, i++));
  events.push(
    makeParticipantStatus(
      P_GEMINI,
      GEMINI_AGENT_ID,
      'Gemini CLI',
      'gemini-cli',
      'passed',
      24600,
      i++,
    ),
  );

  // Claude streams the synthesis (t=25000–45000)
  const synthDeltas = makeStreamedDeltas(
    P_CLAUDE,
    CLAUDE_AGENT_ID,
    SYNTHESIS_TEXT,
    25000,
    20000,
    i,
    5,
  );
  i += synthDeltas.length;
  events.push(...synthDeltas);
  events.push(
    makeMessage(P_CLAUDE, CLAUDE_AGENT_ID, 'Claude Code', SYNTHESIS_TEXT, 3, false, 45100, i++),
  );
  events.push(
    makeParticipantStatus(
      P_CLAUDE,
      CLAUDE_AGENT_ID,
      'Claude Code',
      'claude-code',
      'done',
      45200,
      i++,
    ),
  );

  events.push(makeWaveComplete(3, 46000, i++));

  // Convergence + synthesis
  events.push({
    atMs: jitter(47000, i++),
    roomId: ROOM_ID,
    type: 'room:converged',
    payload: { type: 'room:converged', wave: 3 },
  });
  events.push(makeRoomState('synthesizing', 48000, i++));
  events.push({
    atMs: jitter(50000, i++),
    roomId: ROOM_ID,
    type: 'room:synthesis',
    payload: { type: 'room:synthesis', synthesis: SYNTHESIS_TEXT },
  });
  events.push({
    atMs: jitter(52000, i++),
    roomId: ROOM_ID,
    type: 'brainstorm:outcome',
    payload: {
      type: 'brainstorm:outcome',
      outcome: {
        endState: 'converged',
        totalWaves: 3,
        totalParticipants: 3,
        activeParticipantsAtEnd: 3,
        evictedCount: 0,
        timeoutCount: 0,
        synthesisParseSuccess: true,
        taskCreationCount: 0,
        totalDurationMs: 2700000,
        convergenceWave: 3,
        reflectionWavesTriggered: 0,
        deliverableType: 'decision',
      },
    },
  });
  events.push(makeRoomState('ended', 54000, i++));

  // Sort by atMs to ensure monotonic order despite jitter
  events.sort((a, b) => a.atMs - b.atMs);

  return events;
}

export const room1Events: BrainstormReplayableEvent[] = buildArc();
