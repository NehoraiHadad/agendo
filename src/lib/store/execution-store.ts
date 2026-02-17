'use client';

import { create } from 'zustand';
import type { ExecutionStatus } from '@/lib/types';

export interface ExecutionEntry {
  id: string;
  status: ExecutionStatus;
  taskId: string;
}

interface ExecutionState {
  entries: Record<string, ExecutionEntry>;
}

interface ExecutionActions {
  updateExecution: (entry: ExecutionEntry) => void;
  getActiveExecution: (taskId: string) => ExecutionEntry | null;
}

type ExecutionStore = ExecutionState & ExecutionActions;

const ACTIVE_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['queued', 'running', 'cancelling']);

export const useExecutionStore = create<ExecutionStore>((set, get) => ({
  entries: {},

  updateExecution: (entry) => {
    set((state) => ({
      entries: { ...state.entries, [entry.id]: entry },
    }));
  },

  getActiveExecution: (taskId) => {
    const entries = Object.values(get().entries);
    return entries.find((e) => e.taskId === taskId && ACTIVE_STATUSES.has(e.status)) ?? null;
  },
}));
