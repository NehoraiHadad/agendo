'use client';

import { create } from 'zustand';
import type {
  BrainstormEvent,
  BrainstormParticipantRecovery,
  BrainstormRoomStatus,
} from '@/lib/realtime/event-types';
import type { BrainstormWithDetails } from '@/lib/services/brainstorm-service';

/** Re-export for convenient use in UI components */
export type { WaveQualityScore } from '@/lib/worker/brainstorm-quality';

// ============================================================================
// Types
// ============================================================================

export interface ParticipantState {
  participantId: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  sessionId: string | null;
  model: string | null;
  role: string | null;
  status:
    | 'pending'
    | 'active'
    | 'passed'
    | 'left'
    | 'thinking'
    | 'done'
    | 'timeout'
    | 'evicted'
    | 'blocked';
  /** Human-readable description of current activity, e.g. "Reading orchestrator.ts" */
  activity: string | null;
  /** Last surfaced session error for this participant, if any. */
  error: string | null;
  /** Structured automatic recovery state for fallback activity. */
  recovery: BrainstormParticipantRecovery | null;
}

export interface BrainstormMessageItem {
  id: string | number;
  wave: number;
  senderType: 'agent' | 'user';
  participantId?: string;
  agentId?: string;
  agentName?: string;
  content: string;
  isPass: boolean;
  ts: number;
}

// ============================================================================
// Store
// ============================================================================

/** Active review window state — present during the wave:review pause */
export interface ReviewState {
  wave: number;
  timeoutSec: number;
}

interface BrainstormState {
  roomId: string | null;
  title: string;
  topic: string;
  status: BrainstormRoomStatus;
  currentWave: number;
  maxWaves: number;
  synthesis: string | null;
  project: { id: string; name: string } | null;
  task: { id: string; title: string } | null;

  /** Participant ID of the designated leader, or null */
  leaderParticipantId: string | null;

  /** participantId → participant state */
  participants: Map<string, ParticipantState>;

  /** Ordered messages, deduplicated */
  messages: BrainstormMessageItem[];

  /** participantId → accumulated streaming text */
  streamingText: Map<string, string>;

  /** Whether the room has ended via converge or max-waves */
  converged: boolean;
  maxWavesReached: boolean;

  /**
   * Active review window — set on wave:review, cleared on wave:start.
   * When non-null, the UI should show feedback buttons on participant messages.
   */
  reviewState: ReviewState | null;

  /** Quality scores indexed by wave number */
  waveQualityScores: Map<number, import('@/lib/worker/brainstorm-quality').WaveQualityScore>;

  /** Set of wave numbers that were reflection waves */
  reflectionWaves: Set<number>;

  /** Pending telemetry report — shown to user for opt-in GitHub submission */
  pendingTelemetryReport: import('@/lib/brainstorm/telemetry').BrainstormTelemetryReport | null;

  // Actions
  setRoom: (room: BrainstormWithDetails) => void;
  handleEvent: (event: BrainstormEvent) => void;
  /** Process multiple events in a single state update (one set() call).
   *  Used during SSE catchup to avoid O(n) re-renders for n events. */
  handleEventBatch: (events: BrainstormEvent[]) => void;
  reset: () => void;
}

const initialState: Omit<
  BrainstormState,
  'setRoom' | 'handleEvent' | 'handleEventBatch' | 'reset'
> = {
  roomId: null,
  title: '',
  topic: '',
  status: 'waiting',
  currentWave: 0,
  maxWaves: 10,
  synthesis: null,
  project: null,
  task: null,
  leaderParticipantId: null,
  participants: new Map(),
  messages: [],
  streamingText: new Map(),
  converged: false,
  maxWavesReached: false,
  reviewState: null,
  waveQualityScores: new Map(),
  reflectionWaves: new Set(),
  pendingTelemetryReport: null,
};

// ============================================================================
// Message dedup — module-level Set for O(1) lookups
// ============================================================================

/**
 * Build a composite key for message deduplication.
 * Matches the same fields the original `.some()` compared.
 */
export function messageKey(m: {
  wave: number;
  senderType: string;
  agentId?: string;
  content: string;
  isPass: boolean;
}): string {
  return `${m.wave}\0${m.senderType}\0${m.agentId ?? ''}\0${m.isPass}\0${m.content}`;
}

/** Module-level dedup index — not part of Zustand state to avoid triggering renders. */
let msgDedupKeys = new Set<string>();

// ============================================================================
// Helpers
// ============================================================================

function resolveParticipantKey(
  participants: Map<string, ParticipantState>,
  input: { participantId?: string; agentId?: string },
): string | null {
  if (input.participantId && participants.has(input.participantId)) {
    return input.participantId;
  }

  if (input.agentId) {
    for (const [, participant] of participants) {
      if (participant.agentId === input.agentId) {
        return participant.participantId;
      }
    }
  }

  return input.participantId ?? null;
}

// ============================================================================
// Mutable state accumulator for batch processing
// ============================================================================

/** Mutable state bucket — processEvent mutates this in-place. */
interface MutableState {
  status: BrainstormRoomStatus;
  currentWave: number;
  maxWaves: number;
  synthesis: string | null;
  converged: boolean;
  maxWavesReached: boolean;
  reviewState: ReviewState | null;
  participants: Map<string, ParticipantState>;
  messages: BrainstormMessageItem[];
  streamingText: Map<string, string>;
  waveQualityScores: Map<number, import('@/lib/worker/brainstorm-quality').WaveQualityScore>;
  reflectionWaves: Set<number>;
  pendingTelemetryReport: import('@/lib/brainstorm/telemetry').BrainstormTelemetryReport | null;
}

/**
 * Process a single event against mutable state.
 * Used by both handleEvent (wraps one event) and handleEventBatch (loops N events).
 * The `dedupSet` tracks message keys to prevent duplicates in O(1).
 */
function processEvent(s: MutableState, dedupSet: Set<string>, event: BrainstormEvent): void {
  switch (event.type) {
    case 'room:state': {
      s.status = event.status;
      break;
    }

    case 'wave:start': {
      s.currentWave = event.wave;
      s.reviewState = null;
      break;
    }

    case 'wave:review': {
      s.reviewState = { wave: event.wave, timeoutSec: event.timeoutSec };
      break;
    }

    case 'wave:complete': {
      s.streamingText = new Map<string, string>();
      break;
    }

    case 'participant:status': {
      const participantKey = resolveParticipantKey(s.participants, {
        participantId: event.participantId,
        agentId: event.agentId,
      });
      const existing = participantKey ? s.participants.get(participantKey) : undefined;
      const displayStatus =
        event.status === 'evicted'
          ? ('left' as const)
          : (event.status as Exclude<typeof event.status, 'evicted'>);
      if (existing) {
        const clearActivity = event.status !== 'thinking';
        s.participants.set(existing.participantId, {
          ...existing,
          agentId: event.agentId,
          agentName: event.agentName,
          agentSlug: event.agentSlug ?? existing.agentSlug,
          status: displayStatus,
          model: event.model === undefined ? existing.model : (event.model ?? null),
          activity: clearActivity ? null : existing.activity,
          error: event.status === 'thinking' ? null : (event.error ?? null),
          recovery: event.recovery === undefined ? existing.recovery : (event.recovery ?? null),
        });
      } else {
        s.participants.set(event.participantId, {
          participantId: event.participantId,
          agentId: event.agentId,
          agentName: event.agentName,
          agentSlug: event.agentSlug ?? '',
          sessionId: null,
          model: event.model ?? null,
          role: null,
          status: displayStatus,
          activity: null,
          error: event.status === 'thinking' ? null : (event.error ?? null),
          recovery: event.recovery ?? null,
        });
      }
      break;
    }

    case 'participant:activity': {
      const participantKey = resolveParticipantKey(s.participants, {
        participantId: event.participantId,
        agentId: event.agentId,
      });
      const existing = participantKey ? s.participants.get(participantKey) : undefined;
      if (existing) {
        s.participants.set(existing.participantId, {
          ...existing,
          activity: event.description,
          recovery: event.recovery === undefined ? existing.recovery : (event.recovery ?? null),
        });
      }
      break;
    }

    case 'message': {
      const key = messageKey(event);
      if (dedupSet.has(key)) break;
      dedupSet.add(key);

      s.messages.push({
        id: event.id,
        wave: event.wave,
        senderType: event.senderType,
        participantId: event.participantId,
        agentId: event.agentId,
        agentName: event.agentName,
        content: event.content,
        isPass: event.isPass,
        ts: event.ts,
      });

      // Clear streaming text for this agent since final message arrived
      const streamingKey =
        event.participantId ??
        (event.agentId ? resolveParticipantKey(s.participants, { agentId: event.agentId }) : null);
      if (streamingKey) {
        s.streamingText.delete(streamingKey);
      }
      break;
    }

    case 'message:delta': {
      const participantKey =
        event.participantId ?? resolveParticipantKey(s.participants, { agentId: event.agentId });
      if (!participantKey) break;
      const existingText = s.streamingText.get(participantKey) ?? '';
      s.streamingText.set(participantKey, existingText + event.text);
      break;
    }

    case 'room:config': {
      s.maxWaves = event.maxWaves;
      break;
    }

    case 'room:converged': {
      s.status = 'paused';
      s.converged = true;
      break;
    }

    case 'room:soft-converged':
    case 'room:stalled': {
      // Informational events — no state change needed in the store
      break;
    }

    case 'room:max-waves': {
      s.status = 'paused';
      s.maxWavesReached = true;
      break;
    }

    case 'room:synthesis': {
      s.synthesis = event.synthesis;
      break;
    }

    case 'room:telemetry': {
      s.pendingTelemetryReport = event.report;
      break;
    }

    case 'participant:joined': {
      const participantKey = resolveParticipantKey(s.participants, {
        participantId: event.participantId,
        agentId: event.agentId,
      });
      if (!participantKey || !s.participants.has(participantKey)) {
        s.participants.set(event.participantId, {
          participantId: event.participantId,
          agentId: event.agentId,
          agentName: event.agentName,
          agentSlug: event.agentSlug ?? '',
          sessionId: null,
          model: event.model ?? null,
          role: event.role ?? null,
          status: 'pending',
          activity: null,
          error: null,
          recovery: event.recovery ?? null,
        });
      } else {
        const existing = s.participants.get(participantKey);
        if (existing) {
          s.participants.set(existing.participantId, {
            ...existing,
            agentId: event.agentId,
            agentName: event.agentName,
            agentSlug: event.agentSlug ?? existing.agentSlug,
            model: event.model === undefined ? existing.model : (event.model ?? null),
            role: event.role ?? existing.role,
            recovery: event.recovery === undefined ? existing.recovery : (event.recovery ?? null),
          });
        }
      }
      break;
    }

    case 'participant:left': {
      const participantKey = resolveParticipantKey(s.participants, {
        participantId: event.participantId,
        agentId: event.agentId,
      });
      const existing = participantKey ? s.participants.get(participantKey) : undefined;
      if (existing) {
        s.participants.set(existing.participantId, {
          ...existing,
          agentId: event.agentId,
          agentName: event.agentName,
          agentSlug: event.agentSlug ?? existing.agentSlug,
          status: 'left',
          activity: event.error ? existing.activity : null,
          error: event.error ?? existing.error ?? null,
          recovery: event.recovery === undefined ? existing.recovery : (event.recovery ?? null),
        });
      }
      break;
    }

    case 'wave:quality': {
      s.waveQualityScores.set(event.wave, event.score);
      break;
    }

    case 'wave:reflection': {
      s.reflectionWaves.add(event.wave);
      break;
    }

    case 'room:error': {
      // Errors are displayed via the UI — no state change needed
      break;
    }
  }
}

// ============================================================================
// Store creation
// ============================================================================

export const useBrainstormStore = create<BrainstormState>((set, get) => ({
  ...initialState,

  setRoom: (room) => {
    const participants = new Map<string, ParticipantState>();
    for (const p of room.participants) {
      participants.set(p.id, {
        participantId: p.id,
        agentId: p.agentId,
        agentName: p.agentName,
        agentSlug: p.agentSlug,
        sessionId: p.sessionId ?? null,
        model: p.model ?? null,
        role: p.role ?? null,
        status: p.status as ParticipantState['status'],
        activity: null,
        error: null,
        recovery: null,
      });
    }

    // Reset dedup index when a new room is loaded
    msgDedupKeys = new Set<string>();

    // Messages are not pre-populated here. The SSE endpoint replays them
    // from the log file on connect, so handleEvent() populates the message
    // list via 'message' events after the SSE stream is established.
    set({
      roomId: room.id,
      title: room.title,
      topic: room.topic,
      status: room.status,
      currentWave: room.currentWave,
      maxWaves: room.maxWaves,
      synthesis: room.synthesis ?? null,
      project: room.project,
      task: room.task,
      leaderParticipantId: room.leaderParticipantId ?? null,
      participants,
      messages: [],
      streamingText: new Map(),
      converged: false,
      maxWavesReached: false,
    });
  },

  handleEvent: (event) => {
    const state = get();

    // Clone only the mutable collections that processEvent may modify.
    // For single events, we clone participants/streamingText/etc. upfront
    // (same cost as the original code which cloned per-case).
    const mutable: MutableState = {
      status: state.status,
      currentWave: state.currentWave,
      maxWaves: state.maxWaves,
      synthesis: state.synthesis,
      converged: state.converged,
      maxWavesReached: state.maxWavesReached,
      reviewState: state.reviewState,
      participants: new Map(state.participants),
      messages: [...state.messages],
      streamingText: new Map(state.streamingText),
      waveQualityScores: new Map(state.waveQualityScores),
      reflectionWaves: new Set(state.reflectionWaves),
      pendingTelemetryReport: state.pendingTelemetryReport,
    };

    const prevMsgCount = mutable.messages.length;
    processEvent(mutable, msgDedupKeys, event);

    // Only set the fields that could have changed for this event type
    // to minimize unnecessary reference changes for Zustand selectors.
    // For simple scalar-only events, avoid cloning collections.
    switch (event.type) {
      case 'room:state':
        set({ status: mutable.status });
        return;
      case 'wave:start':
        set({ currentWave: mutable.currentWave, reviewState: null });
        return;
      case 'wave:review':
        set({ reviewState: mutable.reviewState });
        return;
      case 'wave:complete':
        set({ streamingText: mutable.streamingText });
        return;
      case 'room:config':
        set({ maxWaves: mutable.maxWaves });
        return;
      case 'room:converged':
        set({ status: mutable.status, converged: true });
        return;
      case 'room:max-waves':
        set({ status: mutable.status, maxWavesReached: true });
        return;
      case 'room:synthesis':
        set({ synthesis: mutable.synthesis });
        return;
      case 'room:telemetry':
        set({ pendingTelemetryReport: mutable.pendingTelemetryReport });
        return;
      case 'room:error':
      case 'room:soft-converged':
      case 'room:stalled':
        return; // No state change
      default:
        break;
    }

    // For participant/message events, set the changed collections
    const patch: Partial<BrainstormState> = {};

    // Participants may have changed
    if (
      event.type === 'participant:status' ||
      event.type === 'participant:activity' ||
      event.type === 'participant:joined' ||
      event.type === 'participant:left'
    ) {
      patch.participants = mutable.participants;
    }

    // Messages may have been added
    if (mutable.messages.length !== prevMsgCount) {
      patch.messages = mutable.messages;
      patch.streamingText = mutable.streamingText;
    }

    // Streaming text may have changed
    if (event.type === 'message:delta') {
      patch.streamingText = mutable.streamingText;
    }

    // Quality/reflection
    if (event.type === 'wave:quality') {
      patch.waveQualityScores = mutable.waveQualityScores;
    }
    if (event.type === 'wave:reflection') {
      patch.reflectionWaves = mutable.reflectionWaves;
    }

    if (Object.keys(patch).length > 0) {
      set(patch);
    }
  },

  handleEventBatch: (events) => {
    if (events.length === 0) return;

    // For a single event, delegate to handleEvent (avoids full clone overhead)
    if (events.length === 1) {
      get().handleEvent(events[0]);
      return;
    }

    const state = get();

    // Clone all mutable state once — processEvent mutates in-place
    const mutable: MutableState = {
      status: state.status,
      currentWave: state.currentWave,
      maxWaves: state.maxWaves,
      synthesis: state.synthesis,
      converged: state.converged,
      maxWavesReached: state.maxWavesReached,
      reviewState: state.reviewState,
      participants: new Map(state.participants),
      messages: [...state.messages],
      streamingText: new Map(state.streamingText),
      waveQualityScores: new Map(state.waveQualityScores),
      reflectionWaves: new Set(state.reflectionWaves),
      pendingTelemetryReport: state.pendingTelemetryReport,
    };

    // Process all events in a single pass with O(1) dedup
    for (const event of events) {
      processEvent(mutable, msgDedupKeys, event);
    }

    // Single set() call — one React re-render for the entire batch
    set({
      status: mutable.status,
      currentWave: mutable.currentWave,
      maxWaves: mutable.maxWaves,
      synthesis: mutable.synthesis,
      converged: mutable.converged,
      maxWavesReached: mutable.maxWavesReached,
      reviewState: mutable.reviewState,
      participants: mutable.participants,
      messages: mutable.messages,
      streamingText: mutable.streamingText,
      waveQualityScores: mutable.waveQualityScores,
      reflectionWaves: mutable.reflectionWaves,
    });
  },

  reset: () => {
    msgDedupKeys = new Set<string>();
    set({
      ...initialState,
      participants: new Map(),
      messages: [],
      streamingText: new Map(),
      reviewState: null,
      waveQualityScores: new Map(),
      reflectionWaves: new Set(),
    });
  },
}));
