/**
 * Typed event factories for demo SSE replay.
 *
 * Each factory returns a ReplayableEvent — the shape consumed by the SSE replay
 * engine (Agent 2A's replay.ts). Until replay.ts lands we define the interface here.
 *
 * Payload alignment with AgendoEvent discriminated union:
 *   - session:start  → session:init  (requires sessionRef, slashCommands, mcpServers)
 *   - session:end    → session:state with status:'ended'
 *   - permissionRequest → agent:tool-approval (requires approvalId, toolInput, dangerLevel)
 *   - modeChange     → session:mode-change (carries mode:string only, no from/to in the union)
 *   - agentResult    → agent:text (for the summary text) + agent:result (for metrics)
 *
 * Jitter: Each factory applies ±50ms deterministic jitter using a seeded xorshift32 PRNG
 * seeded from the sessionId so replays are reproducible but don't feel robotic.
 */

import type { AgendoEventPayload } from '@/lib/realtime/event-types';

// ---------------------------------------------------------------------------
// ReplayableEvent — the wire shape consumed by the replay engine.
// We define it here; Agent 2A's replay.ts is expected to re-export (or match) it.
// ---------------------------------------------------------------------------

export interface ReplayableEvent {
  /** Milliseconds from the start of the replay at which this event fires. */
  atMs: number;
  /** Session this event belongs to. */
  sessionId: string;
  /** Discriminant — mirrors AgendoEvent['type']. */
  type: AgendoEventPayload['type'];
  /** Event payload (all fields except id, sessionId, ts). */
  payload: AgendoEventPayload;
}

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG — xorshift32
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

/** Derive a numeric seed from a sessionId string. */
function seedFromId(sessionId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Apply ±20ms jitter to atMs, seeded from sessionId + position index.
 *
 * We use ±20ms (not ±50ms as in the original spec) because streamedText chunks
 * are spaced as little as ~40ms apart in short windows, so larger jitter would
 * violate the required monotonic ordering invariant. ±20ms is sufficient to make
 * replays feel non-robotic while keeping all events in order.
 */
function jitter(atMs: number, sessionId: string, index: number): number {
  const seed = (seedFromId(sessionId) ^ (index * 0x9e3779b9)) >>> 0;
  const rng = xorshift32(seed);
  const delta = Math.round((rng() - 0.5) * 40); // ±20ms
  return Math.max(0, atMs + delta);
}

// ---------------------------------------------------------------------------
// Counter for deterministic toolUseId generation per call site.
// Each factory invocation increments a global counter to ensure uniqueness.
// ---------------------------------------------------------------------------
let _toolUseCounter = 0;

export function makeToolUseId(sessionId: string): string {
  _toolUseCounter += 1;
  return `toolu_demo_${sessionId.slice(0, 8)}_${String(_toolUseCounter).padStart(3, '0')}`;
}

// Reset counter (useful for tests that need reproducible IDs).
export function _resetToolUseCounter(): void {
  _toolUseCounter = 0;
}

// ---------------------------------------------------------------------------
// Individual event factories
// ---------------------------------------------------------------------------

/** Session started — maps to session:init */
export function sessionStart(sessionId: string, atMs: number, index = 0): ReplayableEvent {
  const payload: Extract<AgendoEventPayload, { type: 'session:init' }> = {
    type: 'session:init',
    sessionRef: `demo-${sessionId.slice(0, 8)}`,
    slashCommands: [],
    mcpServers: [{ name: 'agendo', status: 'connected', tools: ['get_my_task', 'update_task'] }],
    model: 'claude-opus-4-5',
    permissionMode: 'default',
    cwd: '/home/ubuntu/projects/agendo',
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'session:init', payload };
}

/** Single agent text block — maps to agent:text */
export function agentText(
  sessionId: string,
  text: string,
  atMs: number,
  index = 0,
): ReplayableEvent {
  const payload: Extract<AgendoEventPayload, { type: 'agent:text' }> = {
    type: 'agent:text',
    text,
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'agent:text', payload };
}

/** Streaming text delta — maps to agent:text-delta */
export function agentTextDelta(
  sessionId: string,
  delta: string,
  atMs: number,
  index = 0,
): ReplayableEvent {
  const payload: Extract<AgendoEventPayload, { type: 'agent:text-delta' }> = {
    type: 'agent:text-delta',
    text: delta,
    fromDelta: true,
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'agent:text-delta', payload };
}

/** Tool invocation started — maps to agent:tool-start */
export function toolStart(
  sessionId: string,
  toolUseId: string,
  toolName: string,
  args: Record<string, unknown>,
  atMs: number,
  index = 0,
): ReplayableEvent {
  const payload: Extract<AgendoEventPayload, { type: 'agent:tool-start' }> = {
    type: 'agent:tool-start',
    toolUseId,
    toolName,
    input: args,
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'agent:tool-start', payload };
}

/** Tool invocation ended — maps to agent:tool-end */
export function toolEnd(
  sessionId: string,
  toolUseId: string,
  result: unknown,
  atMs: number,
  durationMs?: number,
  index = 0,
): ReplayableEvent {
  const payload: Extract<AgendoEventPayload, { type: 'agent:tool-end' }> = {
    type: 'agent:tool-end',
    toolUseId,
    content: result,
    durationMs,
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'agent:tool-end', payload };
}

/**
 * Agent result metrics — maps to agent:result.
 * NOTE: Emit agentText() immediately before this to show a summary string,
 * since agent:result carries only metrics (no summary text field).
 */
export function agentResult(
  sessionId: string,
  _summary: string,
  atMs: number,
  index = 0,
): ReplayableEvent {
  // _summary is intentionally unused here — callers should emit agentText() first.
  // We accept the arg to keep the factory signature matching the spec.
  const payload: Extract<AgendoEventPayload, { type: 'agent:result' }> = {
    type: 'agent:result',
    costUsd: 0.0042,
    turns: 5,
    durationMs: atMs,
    isError: false,
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'agent:result', payload };
}

/**
 * Permission request — maps to agent:tool-approval.
 * The `details` string is included in toolInput for display.
 */
export function permissionRequest(
  sessionId: string,
  tool: string,
  details: string,
  atMs: number,
  index = 0,
): ReplayableEvent {
  const approvalId = `approval_${sessionId.slice(0, 8)}_${index}`;
  const payload: Extract<AgendoEventPayload, { type: 'agent:tool-approval' }> = {
    type: 'agent:tool-approval',
    approvalId,
    toolName: tool,
    toolInput: { description: details },
    dangerLevel: 2,
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'agent:tool-approval', payload };
}

/**
 * Mode change — maps to session:mode-change.
 * Note: AgendoEvent's session:mode-change only carries `mode` (not from/to).
 * The `from` parameter is accepted for caller clarity but is not emitted.
 */
export function modeChange(
  sessionId: string,
  _from: string,
  to: string,
  atMs: number,
  index = 0,
): ReplayableEvent {
  const payload: Extract<AgendoEventPayload, { type: 'session:mode-change' }> = {
    type: 'session:mode-change',
    mode: to,
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'session:mode-change', payload };
}

/**
 * Session ended — maps to session:state with status:'ended'.
 * The `reason` parameter is accepted for caller clarity but session:state only carries status.
 */
export function sessionEnd(
  sessionId: string,
  _reason: string,
  atMs: number,
  index = 0,
): ReplayableEvent {
  const payload: Extract<AgendoEventPayload, { type: 'session:state' }> = {
    type: 'session:state',
    status: 'ended',
  };
  return { atMs: jitter(atMs, sessionId, index), sessionId, type: 'session:state', payload };
}

// ---------------------------------------------------------------------------
// streamedText — chunks fullText into word-boundary deltas spread over a duration
// ---------------------------------------------------------------------------

/**
 * Splits fullText into word-boundary chunks and returns an array of
 * agent:text-delta ReplayableEvents spread linearly from startMs to
 * startMs + totalDurationMs.
 *
 * Chunking strategy: split on whitespace boundaries so words stay intact.
 * Groups of ~2-3 tokens (word + optional trailing space) form one delta.
 */
export function streamedText(
  sessionId: string,
  fullText: string,
  startMs: number,
  totalDurationMs: number,
  indexOffset = 0,
): ReplayableEvent[] {
  // Split on whitespace, keeping delimiters (so spaces stay attached to tokens)
  const rawTokens = fullText.split(/(\s+)/);
  // Pair each word with its following whitespace to form natural chunks
  const chunks: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 2) {
    const word = rawTokens[i] ?? '';
    const space = rawTokens[i + 1] ?? '';
    if (word.length > 0 || space.length > 0) {
      chunks.push(word + space);
    }
  }

  if (chunks.length === 0) return [];

  const intervalMs = totalDurationMs / chunks.length;

  return chunks.map((chunk, i) => {
    const atMs = startMs + Math.round(i * intervalMs);
    return agentTextDelta(sessionId, chunk, atMs, indexOffset + i);
  });
}
