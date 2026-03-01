'use client';

import { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { deleteTaskAction } from '@/lib/actions/task-actions';
import { TaskDetailHeader } from './task-detail-header';
import { TaskMetaPanel } from './task-meta-panel';
import { TaskSubtasksList } from './task-subtasks-list';
import { TaskDependenciesPanel } from './task-dependencies-panel';
import { TaskExecutionHistory } from './task-execution-history';
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
  projectId: string | null;
  inputContext: Record<string, unknown>;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  subtaskCount: number;
  completedSubtaskCount: number;
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
  const removeTask = useTaskBoardStore((s) => s.removeTask);
  const tasksById = useTaskBoardStore((s) => s.tasksById);
  const [details, setDetails] = useState<TaskWithDetails | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

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

  // Sync editable fields from the store whenever a server action updates the task.
  // The store is updated by updateTask() calls in child components; details is not,
  // causing controlled Select/input values to revert without this sync.
  useEffect(() => {
    const storeTask = tasksById[taskId];
    if (!storeTask) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetails((prev) => {
      if (!prev) return prev;
      const rawDue = storeTask.dueAt;
      const dueAt =
        rawDue == null ? null : rawDue instanceof Date ? rawDue.toISOString() : String(rawDue);
      return {
        ...prev,
        title: storeTask.title,
        description: storeTask.description,
        status: storeTask.status,
        priority: storeTask.priority,
        sortOrder: storeTask.sortOrder,
        parentTaskId: storeTask.parentTaskId,
        assigneeAgentId: storeTask.assigneeAgentId,
        projectId: storeTask.projectId ?? null,
        dueAt,
      };
    });
  }, [tasksById, taskId]);

  const close = () => selectTask(null);

  const handleDelete = async () => {
    const result = await deleteTaskAction(taskId);
    if (result.success) {
      removeTask(taskId);
      close();
      toast.success('Task deleted');
    } else {
      toast.error(result.error);
    }
    setDeleteOpen(false);
  };

  return (
    <>
      <Sheet open onOpenChange={(open) => !open && close()}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="flex flex-col w-full sm:w-[480px] sm:max-w-[52vw] p-0 gap-0 border-l border-white/[0.08]"
        >
          {/* Accessible title (hidden visually) */}
          <SheetTitle className="sr-only">Task Details</SheetTitle>

          {/* Sticky header */}
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3 shrink-0">
            <p className="text-xs uppercase tracking-widest text-muted-foreground/60 font-medium">
              Task Details
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setDeleteOpen(true)}
                className="rounded-md p-1.5 text-muted-foreground/60 hover:text-destructive hover:bg-white/[0.06] transition-colors"
                aria-label="Delete task"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                onClick={close}
                className="rounded-md p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-white/[0.06] transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {!details ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <div className="h-5 w-5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                <p className="text-xs text-muted-foreground/50">Loading…</p>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
              <div className="flex flex-col gap-5 px-4 pb-8 pt-4">
                <TaskDetailHeader task={details} />

                <Separator className="bg-white/[0.06]" />

                <TaskMetaPanel task={details} />

                <Separator className="bg-white/[0.06]" />

                <TaskSubtasksList taskId={details.id} />

                <Separator className="bg-white/[0.06]" />

                <TaskDependenciesPanel taskId={details.id} />

                <Separator className="bg-white/[0.06]" />

                <TaskExecutionHistory taskId={details.id} agentId={details.assigneeAgentId} />
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the task and all its executions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
