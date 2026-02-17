'use client';

import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { TaskDetailHeader } from './task-detail-header';
import { TaskMetaPanel } from './task-meta-panel';
import { TaskSubtasksList } from './task-subtasks-list';
import { TaskDependenciesPanel } from './task-dependencies-panel';
import { TaskExecutionHistory } from './task-execution-history';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

interface TaskDetailSheetProps {
  taskId: string;
}

interface TaskWithDetails {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  sortOrder: number;
  parentTaskId: string | null;
  assigneeAgentId: string | null;
  inputContext: Record<string, unknown>;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  subtaskCount: number;
  dependencyCount: number;
  blockedByCount: number;
  assignee: { id: string; name: string; slug: string } | null;
  parentTask: { id: string; title: string } | null;
}

/**
 * Task detail sheet. Parent should render with key={taskId} so that
 * changing the selected task remounts this component with fresh state.
 */
export function TaskDetailSheet({ taskId }: TaskDetailSheetProps) {
  const selectTask = useTaskBoardStore((s) => s.selectTask);
  const [details, setDetails] = useState<TaskWithDetails | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/tasks/${taskId}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((json) => {
        setDetails(json.data);
      })
      .catch(() => {
        // Aborted or network error
      });

    return () => {
      controller.abort();
    };
  }, [taskId]);

  return (
    <Sheet open onOpenChange={(open) => !open && selectTask(null)}>
      <SheetContent side="right" className="w-full sm:w-[40vw] sm:max-w-[600px]">
        <SheetHeader>
          <SheetTitle className="sr-only">Task Details</SheetTitle>
        </SheetHeader>

        {!details ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : (
          <ScrollArea className="h-full pr-4">
            <div className="flex flex-col gap-6 pb-8">
              <TaskDetailHeader task={details} />

              <Separator />

              <TaskMetaPanel task={details} />

              <Separator />

              <TaskSubtasksList taskId={details.id} />

              <Separator />

              <TaskDependenciesPanel taskId={details.id} />

              <Separator />

              <TaskExecutionHistory taskId={details.id} agentId={details.assigneeAgentId} />
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
