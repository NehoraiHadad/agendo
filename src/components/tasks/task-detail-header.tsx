'use client';

import { useState } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import { updateTaskStatusAction, updateTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore, BOARD_COLUMNS } from '@/lib/store/task-board-store';
import { toast } from 'sonner';
import type { TaskStatus } from '@/lib/types';
import type { Task } from '@/lib/types';

interface TaskDetailHeaderProps {
  task: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: number;
    subtaskCount?: number;
    completedSubtaskCount?: number;
  };
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

const PRIORITY_COLORS: Record<number, string> = {
  1: 'text-red-400',
  2: 'text-orange-400',
  3: 'text-blue-400',
  4: 'text-zinc-400',
  5: 'text-zinc-500',
};

const PRIORITY_OPTIONS = [
  { value: '1', label: 'P1 — Critical' },
  { value: '2', label: 'P2 — High' },
  { value: '3', label: 'P3 — Medium' },
  { value: '4', label: 'P4 — Low' },
  { value: '5', label: 'P5 — Lowest' },
];

export function TaskDetailHeader({ task }: TaskDetailHeaderProps) {
  const moveTask = useTaskBoardStore((s) => s.moveTask);
  const updateTask = useTaskBoardStore((s) => s.updateTask);
  const [isPending, setIsPending] = useState(false);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);

  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description ?? '');

  const [warnOpen, setWarnOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);

  const openSubtasks = (task.subtaskCount ?? 0) - (task.completedSubtaskCount ?? 0);

  const doStatusChange = async (newStatus: string) => {
    setIsPending(true);
    const result = await updateTaskStatusAction(task.id, newStatus);
    if (result.success) {
      moveTask(task.id, newStatus as TaskStatus);
    }
    setIsPending(false);
  };

  const handleStatusChange = async (newStatus: string) => {
    const isClosing = newStatus === 'done' || newStatus === 'cancelled';
    if (isClosing && openSubtasks > 0) {
      setPendingStatus(newStatus);
      setWarnOpen(true);
      return;
    }
    await doStatusChange(newStatus);
  };

  const saveTitle = async () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      const result = await updateTaskAction(task.id, { title: trimmed });
      if (result.success) {
        updateTask(result.data as Task);
        toast.success('Title updated');
      }
    }
    setEditingTitle(false);
  };

  const saveDesc = async () => {
    const trimmed = descDraft.trim();
    const result = await updateTaskAction(task.id, { description: trimmed || undefined });
    if (result.success) {
      updateTask(result.data as Task);
    }
    setEditingDesc(false);
  };

  const handlePriorityChange = async (v: string) => {
    const result = await updateTaskAction(task.id, { priority: Number(v) });
    if (result.success) {
      updateTask(result.data as Task);
    }
  };

  return (
    <>
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        {editingTitle ? (
          <Input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
            className="flex-1 h-auto py-0.5 text-base font-semibold"
          />
        ) : (
          <h2
            className="flex-1 text-base font-semibold leading-snug cursor-text hover:underline"
            onClick={() => { setTitleDraft(task.title); setEditingTitle(true); }}
          >
            {task.title}
          </h2>
        )}

        <Select
          value={String(task.priority)}
          onValueChange={handlePriorityChange}
        >
          <SelectTrigger className="w-auto shrink-0 h-auto border-none bg-transparent px-1 py-0.5 text-xs font-mono font-medium focus:ring-0 shadow-none">
            <SelectValue>
              <span className={PRIORITY_COLORS[task.priority] ?? 'text-zinc-400'}>
                P{task.priority}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PRIORITY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                <span className={PRIORITY_COLORS[Number(opt.value)] ?? 'text-zinc-400'}>
                  {opt.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {editingDesc ? (
        <Textarea
          autoFocus
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={saveDesc}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditingDesc(false); }}
          className="text-sm min-h-[72px] resize-none"
        />
      ) : task.description ? (
        <p
          className="text-sm text-muted-foreground/70 leading-relaxed cursor-text"
          onClick={() => { setDescDraft(task.description ?? ''); setEditingDesc(true); }}
        >
          {task.description}
        </p>
      ) : (
        <button
          className="text-sm text-muted-foreground/40 italic text-left"
          onClick={() => { setDescDraft(''); setEditingDesc(true); }}
        >
          Add description…
        </button>
      )}

      <Select
        value={task.status}
        onValueChange={handleStatusChange}
        disabled={isPending}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BOARD_COLUMNS.map((status) => (
            <SelectItem key={status} value={status}>
              {STATUS_LABELS[status]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <AlertDialog open={warnOpen} onOpenChange={setWarnOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open subtasks remaining</AlertDialogTitle>
          <AlertDialogDescription>
            {openSubtasks} subtask{openSubtasks !== 1 ? 's' : ''} still open. Mark this task as{' '}
            {pendingStatus} anyway?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setPendingStatus(null)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              setWarnOpen(false);
              if (pendingStatus) await doStatusChange(pendingStatus);
              setPendingStatus(null);
            }}
          >
            Mark as {pendingStatus}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
