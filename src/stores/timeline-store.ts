'use client';

import { create } from 'zustand';

// ============================================================================
// Types
// ============================================================================

export type TimelineEventType =
  | 'tool_call'
  | 'message'
  | 'task_complete'
  | 'error'
  | 'awaiting_input'
  | 'status_change';

export interface TimelineEvent {
  /** Unique ID for deduplication */
  id: string;
  /** Agent node ID (matches canvas node ID) */
  agentId: string;
  /** Display name for the agent */
  agentName: string;
  /** CSS color for the agent (hex or named color) */
  agentColor: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Classification used for dot color */
  type: TimelineEventType;
  /** Short human-readable description shown in tooltip */
  summary: string;
  /** Optional structured details for expanded view */
  details?: Record<string, unknown>;
}

export interface TimelineState {
  /** All recorded events, ordered by timestamp */
  events: TimelineEvent[];
  /** Unix ms timestamp when the team session started */
  startTime: number;
  /** ID of the currently selected event (highlights node on canvas) */
  selectedEventId: string | null;
  /**
   * Horizontal zoom level in pixels-per-second.
   * Default: 3 (3px/s → 180px/min). Range: [0.5, 80].
   */
  zoomLevel: number;
  /** Current horizontal scroll position of the timeline (px from left) */
  scrollPosition: number;

  // Actions
  addEvent: (event: TimelineEvent) => void;
  addEvents: (events: TimelineEvent[]) => void;
  setSelectedEvent: (id: string | null) => void;
  setZoom: (level: number) => void;
  setScrollPosition: (pos: number) => void;
  setStartTime: (ts: number) => void;
  reset: () => void;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ZOOM = 3; // 3 px/second → 180px per minute
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 80;

// ============================================================================
// Store
// ============================================================================

export const useTimelineStore = create<TimelineState>((set) => ({
  events: [],
  startTime: Date.now(),
  selectedEventId: null,
  zoomLevel: DEFAULT_ZOOM,
  scrollPosition: 0,

  addEvent: (event) =>
    set((state) => ({
      events: [...state.events, event],
    })),

  addEvents: (newEvents) =>
    set((state) => ({
      // Merge and deduplicate by id, then sort by timestamp
      events: deduplicateAndSort([...state.events, ...newEvents]),
    })),

  setSelectedEvent: (id) => set({ selectedEventId: id }),

  setZoom: (level) => set({ zoomLevel: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level)) }),

  setScrollPosition: (pos) => set({ scrollPosition: Math.max(0, pos) }),

  setStartTime: (ts) => set({ startTime: ts }),

  reset: () =>
    set({
      events: [],
      startTime: Date.now(),
      selectedEventId: null,
      zoomLevel: DEFAULT_ZOOM,
      scrollPosition: 0,
    }),
}));

// ============================================================================
// Helpers
// ============================================================================

function deduplicateAndSort(events: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  const unique: TimelineEvent[] = [];
  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      unique.push(event);
    }
  }
  return unique.sort((a, b) => a.timestamp - b.timestamp);
}
