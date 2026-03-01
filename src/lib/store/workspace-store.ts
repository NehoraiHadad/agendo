'use client';

import { create } from 'zustand';
import type { SessionStatus } from '@/lib/realtime/events';
import type { WorkspaceLayout, WorkspacePanel } from '@/lib/types';

const MAX_PANELS = 6;

interface PanelState {
  sessionId: string;
  needsAttention: boolean;
  status: SessionStatus | null;
}

interface WorkspaceState {
  workspaceId: string | null;
  panels: Record<string, PanelState>; // keyed by sessionId
  panelHeights: Record<string, number>; // sessionId → px height (user-resized)
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

  /** Set a panel's user-defined height (in px). Pass null to clear (revert to default). */
  setPanelHeight: (sessionId: string, height: number | null) => void;

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
  panelHeights: {},
  focusedPanelId: null,
  gridCols: 2,
  expandedPanelId: null,
};

export const useWorkspaceStore = create<WorkspaceStore>()((set, get) => ({
  ...initialState,

  setWorkspace: (id, layout) => {
    const panels: Record<string, PanelState> = {};
    const panelHeights: Record<string, number> = {};

    // Respect the MAX_PANELS cap when hydrating from the API
    const cappedPanels = layout.panels.slice(0, MAX_PANELS);
    for (const panel of cappedPanels) {
      panels[panel.sessionId] = {
        sessionId: panel.sessionId,
        needsAttention: false,
        status: null,
      };
      if (panel.height) {
        panelHeights[panel.sessionId] = panel.height;
      }
    }

    set({
      workspaceId: id,
      panels,
      panelHeights,
      gridCols: layout.gridCols,
      focusedPanelId: null,
      expandedPanelId: null,
    });
  },

  addPanel: (sessionId) => {
    set((state) => {
      // Already present — no-op
      if (state.panels[sessionId]) return state;

      // At the limit — no-op
      if (Object.keys(state.panels).length >= MAX_PANELS) return state;

      return {
        panels: {
          ...state.panels,
          [sessionId]: {
            sessionId,
            needsAttention: false,
            status: null,
          },
        },
      };
    });
  },

  removePanel: (sessionId) => {
    set((state) => {
      const { [sessionId]: _, ...remainingPanels } = state.panels;

      return {
        panels: remainingPanels,
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

      // Automatically flag attention when the agent is waiting for input
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

  setPanelHeight: (sessionId, height) => {
    set((state) => {
      if (height === null) {
        const { [sessionId]: _, ...rest } = state.panelHeights;
        return { panelHeights: rest };
      }
      return { panelHeights: { ...state.panelHeights, [sessionId]: height } };
    });
  },

  getSessionIds: () => {
    return Object.keys(get().panels);
  },

  persistLayout: async () => {
    const { workspaceId, panels, panelHeights, gridCols } = get();
    if (!workspaceId) return;

    // Build layout panels array, assigning positional row/col from insertion order
    const panelEntries = Object.values(panels);
    const cols = gridCols;
    const layoutPanels: WorkspacePanel[] = panelEntries.map((panel, index) => ({
      sessionId: panel.sessionId,
      row: Math.floor(index / cols),
      col: index % cols,
      height: panelHeights[panel.sessionId],
    }));

    const layout: WorkspaceLayout = { panels: layoutPanels, gridCols };

    await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout }),
      keepalive: true, // survive page unload (beforeunload/visibilitychange flush)
    });
  },

  reset: () => set(initialState),
}));
