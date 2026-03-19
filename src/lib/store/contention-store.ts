'use client';

import { create } from 'zustand';

export type ContentionSeverity = 'warning' | 'critical';

export interface ContentionInfo {
  severity: ContentionSeverity;
  conflictingFiles: string[];
  sessions: Array<{
    sessionId: string;
    agentName: string;
    branch: string;
  }>;
}

/** Lightweight contention prop for TaskCard display (no session details needed). */
export interface TaskContention {
  severity: ContentionSeverity;
  tooltip?: string;
}

interface ContentionState {
  /** taskId → latest contention info */
  contentionByTaskId: Record<string, ContentionInfo>;

  /** Update contention for a task (called when a session receives a file-contention event) */
  setContention: (taskId: string, info: ContentionInfo) => void;

  /** Clear contention for a task (called when a session ends) */
  clearContention: (taskId: string) => void;
}

export const useContentionStore = create<ContentionState>((set) => ({
  contentionByTaskId: {},

  setContention: (taskId, info) =>
    set((state) => {
      const prev = state.contentionByTaskId[taskId];
      // Skip update if contention data hasn't actually changed
      if (
        prev &&
        prev.severity === info.severity &&
        prev.conflictingFiles.length === info.conflictingFiles.length &&
        prev.conflictingFiles.every((f, i) => f === info.conflictingFiles[i]) &&
        prev.sessions.length === info.sessions.length &&
        prev.sessions.every(
          (s, i) =>
            s.sessionId === info.sessions[i]?.sessionId &&
            s.agentName === info.sessions[i]?.agentName &&
            s.branch === info.sessions[i]?.branch,
        )
      ) {
        return state; // no change — Zustand skips re-render
      }
      return { contentionByTaskId: { ...state.contentionByTaskId, [taskId]: info } };
    }),

  clearContention: (taskId) =>
    set((state) => {
      const { [taskId]: _, ...rest } = state.contentionByTaskId;
      return { contentionByTaskId: rest };
    }),
}));
