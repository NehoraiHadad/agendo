'use client';

import { useTaskBoardStore } from '@/lib/store/task-board-store';
import type { Task } from '@/lib/types';
import { useEventSource } from './use-event-source';

const BOARD_EVENT_NAMES = ['snapshot', 'task_updated', 'task_created', 'heartbeat'] as const;

export function useBoardSse() {
  useEventSource({
    url: '/api/sse/board',
    trackLastEventId: false,
    eventNames: BOARD_EVENT_NAMES as unknown as string[],
    onMessage: (data: unknown, rawEvent: MessageEvent) => {
      const eventType = rawEvent.type;

      if (eventType === 'snapshot') {
        const { tasks } = data as { tasks: Task[] };
        const { applyServerUpdate } = useTaskBoardStore.getState();
        for (const task of tasks) {
          applyServerUpdate(task);
        }
      } else if (eventType === 'task_updated') {
        const task = data as Task;
        useTaskBoardStore.getState().applyServerUpdate(task);
      } else if (eventType === 'task_created') {
        const task = data as Task;
        useTaskBoardStore.getState().applyServerCreate(task);
      }
      // heartbeat events are handled implicitly (reconnect backoff resets on successful message)
    },
  });
}
