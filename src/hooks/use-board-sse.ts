'use client';

import { useEffect, useRef } from 'react';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { useExecutionStore } from '@/lib/store/execution-store';
import type { Task } from '@/lib/types';

const MAX_RETRY_DELAY = 30000;
const BASE_RETRY_DELAY = 1000;

export function useBoardSse() {
  // Access store actions via getState() inside the effect — no reactive subscriptions
  // needed since Zustand action references are stable across renders.
  const retryCount = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let mounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (!mounted) return;

      const es = new EventSource('/api/sse/board');
      esRef.current = es;

      es.addEventListener('snapshot', (e: MessageEvent) => {
        try {
          const { tasks } = JSON.parse(e.data) as { tasks: Task[] };
          const { purgeAdHocTasks, applyServerUpdate } = useTaskBoardStore.getState();
          purgeAdHocTasks();
          for (const task of tasks) {
            applyServerUpdate(task);
          }
        } catch {
          // ignore parse errors
        }
      });

      es.addEventListener('task_updated', (e: MessageEvent) => {
        try {
          const task = JSON.parse(e.data) as Task;
          useTaskBoardStore.getState().applyServerUpdate(task);
        } catch {
          // ignore
        }
      });

      es.addEventListener('task_created', (e: MessageEvent) => {
        try {
          const task = JSON.parse(e.data) as Task;
          // Skip ad-hoc tasks — they are managed via the ad-hoc panel, not the main board
          if (task.isAdHoc) return;
          useTaskBoardStore.getState().applyServerCreate(task);
        } catch {
          // ignore
        }
      });

      es.addEventListener('execution_status', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as {
            id: string;
            taskId: string;
            status: string;
          };
          useExecutionStore.getState().updateExecution({
            id: data.id,
            taskId: data.taskId,
            status: data.status as import('@/lib/types').ExecutionStatus,
          });
        } catch {
          // ignore
        }
      });

      es.addEventListener('heartbeat', () => {
        retryCount.current = 0;
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;

        if (!mounted) return;

        const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, retryCount.current), MAX_RETRY_DELAY);
        retryCount.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      mounted = false;
      clearTimeout(reconnectTimer);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, []); // stable — only runs once; store actions accessed via getState()
}
