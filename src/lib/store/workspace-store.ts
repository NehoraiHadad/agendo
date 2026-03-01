'use client';

import { create } from 'zustand';
import type { LayoutItem } from 'react-grid-layout';
import type { SessionStatus } from '@/lib/realtime/events';
import type { WorkspaceLayout, WorkspacePanel } from '@/lib/types';

const MAX_PANELS = 6;
/** Height of one RGL row unit in pixels */
const ROW_HEIGHT = 100;
/** Default panel height in row units (= 500px) */
const DEFAULT_H = 5;
/** Minimum panel height in row units (= 300px) */
const MIN_H = 3;
/** Fixed RGL grid resolution — panels can span 1–GRID_COLS columns freely */
export const GRID_COLS = 12;

interface PanelState {
  sessionId: string;
  needsAttention: boolean;
  status: SessionStatus | null;
}

interface WorkspaceState {
  workspaceId: string | null;
  panels: Record<string, PanelState>; // keyed by sessionId
  rglLayout: LayoutItem[]; // react-grid-layout positions
  focusedPanelId: string | null;
  expandedPanelId: string | null; // for full-screen overlay
}

interface WorkspaceActions {
  /**
   * Load a workspace from an API response, replacing all panel state with the
   * panels from the provided layout.
   */
  setWorkspace: (id: string, layout: WorkspaceLayout) => void;

  /**
   * Add a new panel for the given sessionId.
   * No-op if the session is already present or the panel count is at the max.
   */
  addPanel: (sessionId: string) => void;

  /**
   * Remove the panel for the given sessionId.
   * Clears focusedPanelId and expandedPanelId if they match.
   */
  removePanel: (sessionId: string) => void;

  /** Set the currently focused (active) panel. */
  setFocused: (sessionId: string | null) => void;

  /** Set the expanded (full-screen overlay) panel. */
  setExpanded: (sessionId: string | null) => void;

  /**
   * Mark or clear the attention indicator for a panel.
   * Set true when the SSE stream receives an agent:tool-approval event or the
   * session status transitions to awaiting_input.
   * Set false when the user focuses/interacts with the panel.
   */
  setNeedsAttention: (sessionId: string, needs: boolean) => void;

  /** Update the live status of a panel (driven by SSE session:state events). */
  setPanelStatus: (sessionId: string, status: SessionStatus) => void;

  /** Update the RGL layout array (called from onLayoutChange). */
  setRglLayout: (layout: LayoutItem[]) => void;

  /** Return all session IDs currently registered in panels (for useMultiSessionStreams). */
  getSessionIds: () => string[];

  /**
   * Persist the current panel layout to the server via PATCH.
   * The caller is responsible for debouncing this call.
   */
  persistLayout: () => Promise<void>;

  /** Reset the store to its initial empty state. */
  reset: () => void;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

const initialState: WorkspaceState = {
  workspaceId: null,
  panels: {},
  rglLayout: [],
  focusedPanelId: null,
  expandedPanelId: null,
};

/**
 * Convert a persisted WorkspacePanel to an RGL LayoutItem.
 *
 * Handles two migrations:
 * 1. Old row/col/height format → new x/y/w/h format
 * 2. Old low-resolution grid (e.g. cols=2) → GRID_COLS=12 by scaling x and w
 */
function panelToRglItem(panel: WorkspacePanel, index: number, savedCols: number): LayoutItem {
  const scale = GRID_COLS / savedCols;

  // New x/y/w/h format
  if ('x' in panel && typeof (panel as { x?: unknown }).x === 'number') {
    return {
      i: panel.sessionId,
      x: savedCols === GRID_COLS ? panel.x : Math.round(panel.x * scale),
      y: panel.y,
      w: savedCols === GRID_COLS ? panel.w : Math.max(1, Math.round(panel.w * scale)),
      h: panel.h,
      minH: MIN_H,
    };
  }

  // Old format migration — row/col/height
  const old = panel as unknown as { row?: number; col?: number; height?: number };
  const col = old.col ?? index % savedCols;
  const row = old.row ?? Math.floor(index / savedCols);
  const h = old.height ? Math.max(MIN_H, Math.round(old.height / ROW_HEIGHT)) : DEFAULT_H;
  return {
    i: panel.sessionId,
    x: Math.round(col * scale),
    y: row * DEFAULT_H,
    w: Math.max(1, Math.round(scale)),
    h,
    minH: MIN_H,
  };
}

export const useWorkspaceStore = create<WorkspaceStore>()((set, get) => ({
  ...initialState,

  setWorkspace: (id, layout) => {
    const panels: Record<string, PanelState> = {};
    // Use the saved gridCols only for migration scaling; default 2 for legacy layouts
    const savedCols = layout.gridCols ?? 2;

    const cappedPanels = layout.panels.slice(0, MAX_PANELS);
    const rglLayout: LayoutItem[] = [];

    for (let i = 0; i < cappedPanels.length; i++) {
      const panel = cappedPanels[i];
      panels[panel.sessionId] = {
        sessionId: panel.sessionId,
        needsAttention: false,
        status: null,
      };
      rglLayout.push(panelToRglItem(panel, i, savedCols));
    }

    set({
      workspaceId: id,
      panels,
      rglLayout,
      focusedPanelId: null,
      expandedPanelId: null,
    });
  },

  addPanel: (sessionId) => {
    set((state) => {
      if (state.panels[sessionId]) return state;
      if (Object.keys(state.panels).length >= MAX_PANELS) return state;

      // Place new panel below all existing ones
      const maxY = state.rglLayout.reduce((m, item) => Math.max(m, item.y + item.h), 0);

      return {
        panels: {
          ...state.panels,
          [sessionId]: { sessionId, needsAttention: false, status: null },
        },
        rglLayout: [
          ...state.rglLayout,
          { i: sessionId, x: 0, y: maxY, w: GRID_COLS, h: DEFAULT_H, minH: MIN_H },
        ],
      };
    });
  },

  removePanel: (sessionId) => {
    set((state) => {
      const { [sessionId]: _, ...remainingPanels } = state.panels;

      return {
        panels: remainingPanels,
        rglLayout: state.rglLayout.filter((item) => item.i !== sessionId),
        focusedPanelId: state.focusedPanelId === sessionId ? null : state.focusedPanelId,
        expandedPanelId: state.expandedPanelId === sessionId ? null : state.expandedPanelId,
      };
    });
  },

  setFocused: (sessionId) => set({ focusedPanelId: sessionId }),

  setExpanded: (sessionId) => set({ expandedPanelId: sessionId }),

  setNeedsAttention: (sessionId, needs) => {
    set((state) => {
      const panel = state.panels[sessionId];
      if (!panel) return state;
      return {
        panels: {
          ...state.panels,
          [sessionId]: { ...panel, needsAttention: needs },
        },
      };
    });
  },

  setPanelStatus: (sessionId, status) => {
    set((state) => {
      const panel = state.panels[sessionId];
      if (!panel) return state;

      const needsAttention = status === 'awaiting_input' ? true : panel.needsAttention;

      return {
        panels: {
          ...state.panels,
          [sessionId]: { ...panel, status, needsAttention },
        },
      };
    });
  },

  setRglLayout: (layout) => set({ rglLayout: layout }),

  getSessionIds: () => {
    return Object.keys(get().panels);
  },

  persistLayout: async () => {
    const { workspaceId, rglLayout } = get();
    if (!workspaceId) return;

    const layoutPanels: WorkspacePanel[] = rglLayout.map((item) => ({
      sessionId: item.i,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    }));

    const layout: WorkspaceLayout = { panels: layoutPanels, gridCols: GRID_COLS };

    await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout }),
      keepalive: true,
    });
  },

  reset: () => set(initialState),
}));
