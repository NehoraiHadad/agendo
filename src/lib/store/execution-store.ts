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
  /** O(1) lookup: taskId → active ExecutionEntry (queued/running/cancelling) */
  activeByTaskId: Record<string, ExecutionEntry>;
}

interface ExecutionActions {
  updateExecution: (entry: ExecutionEntry) => void;
  getActiveExecution: (taskId: string) => ExecutionEntry | null;
}

type ExecutionStore = ExecutionState & ExecutionActions;

const ACTIVE_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['queued', 'running', 'cancelling']);

export const useExecutionStore = create<ExecutionStore>((set, get) => ({
  entries: {},
  activeByTaskId: {},

  updateExecution: (entry) => {
    set((state) => {
      const newEntries = { ...state.entries, [entry.id]: entry };
      const newActiveByTaskId = { ...state.activeByTaskId };

      if (ACTIVE_STATUSES.has(entry.status)) {
        newActiveByTaskId[entry.taskId] = entry;
      } else if (newActiveByTaskId[entry.taskId]?.id === entry.id) {
        // Only evict if this exact execution was the tracked active one
        const { [entry.taskId]: _, ...rest } = newActiveByTaskId;
        return { entries: newEntries, activeByTaskId: rest };
      }

      return { entries: newEntries, activeByTaskId: newActiveByTaskId };
    });
  },

  getActiveExecution: (taskId) => {
    return get().activeByTaskId[taskId] ?? null;
  },
}));
