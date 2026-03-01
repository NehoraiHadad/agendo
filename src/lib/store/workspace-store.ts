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
  gridCols: 2 | 3;
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

  /** Switch between 2-column and 3-column grid layouts. */
  setGridCols: (cols: 2 | 3) => void;

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
  gridCols: 2,
  expandedPanelId: null,
};

/**
 * Convert a persisted WorkspacePanel to an RGL LayoutItem, migrating old
 * row/col/height format to the new x/y/w/h format transparently.
 */
function panelToRglItem(panel: WorkspacePanel, index: number, cols: number): LayoutItem {
  // New format — has x/y/w/h directly
  if ('x' in panel && typeof (panel as { x?: unknown }).x === 'number') {
    return { i: panel.sessionId, x: panel.x, y: panel.y, w: panel.w, h: panel.h, minH: MIN_H };
  }

  // Old format migration — row/col/height
  const old = panel as unknown as { row?: number; col?: number; height?: number };
  const col = old.col ?? index % cols;
  const row = old.row ?? Math.floor(index / cols);
  const h = old.height ? Math.max(MIN_H, Math.round(old.height / ROW_HEIGHT)) : DEFAULT_H;
  return { i: panel.sessionId, x: col, y: row * DEFAULT_H, w: 1, h, minH: MIN_H };
}

export const useWorkspaceStore = create<WorkspaceStore>()((set, get) => ({
  ...initialState,

  setWorkspace: (id, layout) => {
    const panels: Record<string, PanelState> = {};
    const cols = layout.gridCols ?? 2;

    const cappedPanels = layout.panels.slice(0, MAX_PANELS);
    const rglLayout: LayoutItem[] = [];

    for (let i = 0; i < cappedPanels.length; i++) {
      const panel = cappedPanels[i];
      panels[panel.sessionId] = {
        sessionId: panel.sessionId,
        needsAttention: false,
        status: null,
      };
      rglLayout.push(panelToRglItem(panel, i, cols));
    }

    set({
      workspaceId: id,
      panels,
      rglLayout,
      gridCols: cols,
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
          { i: sessionId, x: 0, y: maxY, w: 1, h: DEFAULT_H, minH: MIN_H },
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

  setGridCols: (cols) => set({ gridCols: cols }),

  setRglLayout: (layout) => set({ rglLayout: layout }),

  getSessionIds: () => {
    return Object.keys(get().panels);
  },

  persistLayout: async () => {
    const { workspaceId, rglLayout, gridCols } = get();
    if (!workspaceId) return;

    const layoutPanels: WorkspacePanel[] = rglLayout.map((item) => ({
      sessionId: item.i,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    }));

    const layout: WorkspaceLayout = { panels: layoutPanels, gridCols };

    await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout }),
      keepalive: true,
    });
  },

  reset: () => set(initialState),
}));
