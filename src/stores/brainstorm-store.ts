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
  status: 'pending' | 'active' | 'passed' | 'left' | 'thinking' | 'done' | 'timeout' | 'evicted';
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

  // Actions
  setRoom: (room: BrainstormWithDetails) => void;
  handleEvent: (event: BrainstormEvent) => void;
  reset: () => void;
}

const initialState: Omit<BrainstormState, 'setRoom' | 'handleEvent' | 'reset'> = {
  roomId: null,
  title: '',
  topic: '',
  status: 'waiting',
  currentWave: 0,
  maxWaves: 10,
  synthesis: null,
  project: null,
  task: null,
  participants: new Map(),
  messages: [],
  streamingText: new Map(),
  converged: false,
  maxWavesReached: false,
  reviewState: null,
  waveQualityScores: new Map(),
  reflectionWaves: new Set(),
};

function resolveParticipantKey(
  participants: Map<string, ParticipantState>,
  input: { participantId?: string; agentId?: string },
): string | null {
  if (input.participantId && participants.has(input.participantId)) {
    return input.participantId;
  }

  if (input.agentId) {
    for (const [participantId, participant] of participants) {
      if (participant.agentId === input.agentId) {
        return participantId;
      }
    }
  }

  return input.participantId ?? null;
}

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
      participants,
      messages: [],
      streamingText: new Map(),
      converged: false,
      maxWavesReached: false,
    });
  },

  handleEvent: (event) => {
    const state = get();

    switch (event.type) {
      case 'room:state': {
        set({ status: event.status });
        break;
      }

      case 'wave:start': {
        // Clear the review window when the next wave begins
        set({ currentWave: event.wave, reviewState: null });
        break;
      }

      case 'wave:review': {
        set({ reviewState: { wave: event.wave, timeoutSec: event.timeoutSec } });
        break;
      }

      case 'wave:complete': {
        // Wave complete — clear streaming text for all agents
        const newStreaming = new Map<string, string>();
        set({ streamingText: newStreaming });
        break;
      }

      case 'participant:status': {
        const participants = new Map(state.participants);
        const participantKey = resolveParticipantKey(participants, {
          participantId: event.participantId,
          agentId: event.agentId,
        });
        const existing = participantKey ? participants.get(participantKey) : undefined;
        // 'evicted' is shown as 'left' in the UI (participant was removed due to consecutive timeouts)
        const displayStatus =
          event.status === 'evicted'
            ? ('left' as const)
            : (event.status as Exclude<typeof event.status, 'evicted'>);
        if (existing) {
          // Clear activity when status changes to a terminal state (done/passed/timeout/evicted)
          const clearActivity = event.status !== 'thinking';
          participants.set(existing.participantId, {
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
          // Participant not yet in map — add with minimal info
          participants.set(event.participantId, {
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
        set({ participants });
        break;
      }

      case 'participant:activity': {
        const participants = new Map(state.participants);
        const participantKey = resolveParticipantKey(participants, {
          participantId: event.participantId,
          agentId: event.agentId,
        });
        const existing = participantKey ? participants.get(participantKey) : undefined;
        if (existing) {
          participants.set(existing.participantId, {
            ...existing,
            activity: event.description,
            recovery: event.recovery === undefined ? existing.recovery : (event.recovery ?? null),
          });
        }
        set({ participants });
        break;
      }

      case 'message': {
        const { messages } = state;
        // Deduplicate by content + wave + sender (SSE reconnect may replay)
        const isDuplicate = messages.some(
          (m) =>
            m.wave === event.wave &&
            m.senderType === event.senderType &&
            m.agentId === event.agentId &&
            m.content === event.content &&
            m.isPass === event.isPass,
        );
        if (isDuplicate) break;

        const newMessage: BrainstormMessageItem = {
          id: event.id,
          wave: event.wave,
          senderType: event.senderType,
          participantId: event.participantId,
          agentId: event.agentId,
          agentName: event.agentName,
          content: event.content,
          isPass: event.isPass,
          ts: event.ts,
        };

        // Clear streaming text for this agent since final message arrived
        const newStreaming = new Map(state.streamingText);
        const streamingKey =
          event.participantId ??
          (event.agentId
            ? resolveParticipantKey(state.participants, { agentId: event.agentId })
            : null);
        if (streamingKey) {
          newStreaming.delete(streamingKey);
        }

        set({
          messages: [...messages, newMessage],
          streamingText: newStreaming,
        });
        break;
      }

      case 'message:delta': {
        const newStreaming = new Map(state.streamingText);
        const participantKey =
          event.participantId ??
          resolveParticipantKey(state.participants, { agentId: event.agentId });
        if (!participantKey) break;
        const existing = newStreaming.get(participantKey) ?? '';
        newStreaming.set(participantKey, existing + event.text);
        set({ streamingText: newStreaming });
        break;
      }

      case 'room:converged': {
        set({ status: 'paused', converged: true });
        break;
      }

      case 'room:max-waves': {
        set({ status: 'paused', maxWavesReached: true });
        break;
      }

      case 'room:synthesis': {
        set({ synthesis: event.synthesis });
        break;
      }

      case 'participant:joined': {
        const participants = new Map(state.participants);
        const participantKey = resolveParticipantKey(participants, {
          participantId: event.participantId,
          agentId: event.agentId,
        });
        if (!participantKey || !participants.has(participantKey)) {
          participants.set(event.participantId, {
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
          const existing = participants.get(participantKey);
          if (existing) {
            participants.set(existing.participantId, {
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
        set({ participants });
        break;
      }

      case 'participant:left': {
        const participants = new Map(state.participants);
        const participantKey = resolveParticipantKey(participants, {
          participantId: event.participantId,
          agentId: event.agentId,
        });
        const existing = participantKey ? participants.get(participantKey) : undefined;
        if (existing) {
          participants.set(existing.participantId, {
            ...existing,
            agentId: event.agentId,
            agentName: event.agentName,
            agentSlug: event.agentSlug ?? existing.agentSlug,
            status: 'left',
            activity: event.error ? existing.activity : null,
            error: event.error ?? existing.error ?? null,
            recovery: event.recovery === undefined ? existing.recovery : (event.recovery ?? null),
          });
          set({ participants });
        }
        break;
      }

      case 'wave:quality': {
        const newQualityScores = new Map(state.waveQualityScores);
        newQualityScores.set(event.wave, event.score);
        set({ waveQualityScores: newQualityScores });
        break;
      }

      case 'wave:reflection': {
        const newReflectionWaves = new Set(state.reflectionWaves);
        newReflectionWaves.add(event.wave);
        set({ reflectionWaves: newReflectionWaves });
        break;
      }

      case 'room:error': {
        // Errors are displayed via the UI — no state change needed
        break;
      }
    }
  },

  reset: () => {
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
