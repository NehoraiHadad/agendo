'use client';

import { create } from 'zustand';
import type { BrainstormEvent, BrainstormRoomStatus } from '@/lib/realtime/event-types';
import type { BrainstormWithDetails } from '@/lib/services/brainstorm-service';

// ============================================================================
// Types
// ============================================================================

export interface ParticipantState {
  agentId: string;
  agentName: string;
  agentSlug: string;
  sessionId: string | null;
  model: string | null;
  status: 'pending' | 'active' | 'passed' | 'left' | 'thinking' | 'done' | 'timeout';
}

export interface BrainstormMessageItem {
  id: string | number;
  wave: number;
  senderType: 'agent' | 'user';
  agentId?: string;
  agentName?: string;
  content: string;
  isPass: boolean;
  ts: number;
}

// ============================================================================
// Store
// ============================================================================

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

  /** agentId → participant state */
  participants: Map<string, ParticipantState>;

  /** Ordered messages, deduplicated */
  messages: BrainstormMessageItem[];

  /** agentId → accumulated streaming text */
  streamingText: Map<string, string>;

  /** Whether the room has ended via converge or max-waves */
  converged: boolean;
  maxWavesReached: boolean;

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
};

export const useBrainstormStore = create<BrainstormState>((set, get) => ({
  ...initialState,

  setRoom: (room) => {
    const participants = new Map<string, ParticipantState>();
    for (const p of room.participants) {
      participants.set(p.agentId, {
        agentId: p.agentId,
        agentName: p.agentName,
        agentSlug: p.agentSlug,
        sessionId: p.sessionId ?? null,
        model: p.model ?? null,
        status: p.status as ParticipantState['status'],
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
        set({ currentWave: event.wave });
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
        const existing = participants.get(event.agentId);
        if (existing) {
          participants.set(event.agentId, { ...existing, status: event.status });
        } else {
          // Participant not yet in map — add with minimal info
          participants.set(event.agentId, {
            agentId: event.agentId,
            agentName: event.agentName,
            agentSlug: '',
            sessionId: null,
            model: null,
            status: event.status,
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
          agentId: event.agentId,
          agentName: event.agentName,
          content: event.content,
          isPass: event.isPass,
          ts: event.ts,
        };

        // Clear streaming text for this agent since final message arrived
        const newStreaming = new Map(state.streamingText);
        if (event.agentId) {
          newStreaming.delete(event.agentId);
        }

        set({
          messages: [...messages, newMessage],
          streamingText: newStreaming,
        });
        break;
      }

      case 'message:delta': {
        const newStreaming = new Map(state.streamingText);
        const existing = newStreaming.get(event.agentId) ?? '';
        newStreaming.set(event.agentId, existing + event.text);
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
        if (!participants.has(event.agentId)) {
          participants.set(event.agentId, {
            agentId: event.agentId,
            agentName: event.agentName,
            agentSlug: '',
            sessionId: null,
            model: null,
            status: 'pending',
          });
          set({ participants });
        }
        break;
      }

      case 'participant:left': {
        const participants = new Map(state.participants);
        const existing = participants.get(event.agentId);
        if (existing) {
          participants.set(event.agentId, { ...existing, status: 'left' });
          set({ participants });
        }
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
    });
  },
}));
