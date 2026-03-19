'use client';

import { useCallback, useMemo, useState } from 'react';
import { useFetch } from '@/hooks/use-fetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  createTaskAction,
  deleteTaskAction,
  updateTaskStatusAction,
} from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { ChevronDown, ChevronRight, GitBranch, X as XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Task } from '@/lib/types';
import type { TaskBoardItem } from '@/lib/services/task-service';

/* ─── SubtaskRow ───────────────────────────────────────────── */

interface SubtaskRowProps {
  task: TaskBoardItem;
  depth: number;
  projectId?: string | null;
  onDelete: (id: string) => void;
}

function SubtaskRow({ task, depth, projectId, onDelete }: SubtaskRowProps) {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const removeTask = useTaskBoardStore((s) => s.removeTask);
  const selectTask = useTaskBoardStore((s) => s.selectTask);

  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<TaskBoardItem[]>([]);
  const [loadedChildren, setLoadedChildren] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  // A task "has subtasks" if the DB count says so, or we've already loaded some
  const hasSubtasks = task.subtaskTotal > 0 || children.length > 0;

  const loadChildren = useCallback(async () => {
    if (loadedChildren) return;
    const res = await fetch(`/api/tasks/${task.id}/subtasks`);
    const json = (await res.json()) as { data: TaskBoardItem[] };
    setChildren(json.data ?? []);
    setLoadedChildren(true);
  }, [task.id, loadedChildren]);

  const handleToggle = async () => {
    if (!isExpanded && !loadedChildren) {
      await loadChildren();
    }
    setIsExpanded((prev) => !prev);
  };

  const handleAddChild = async () => {
    if (!newTitle.trim()) return;
    const result = await createTaskAction({
      title: newTitle.trim(),
      parentTaskId: task.id,
      projectId: projectId ?? undefined,
    });
    if (result.success) {
      const newTask = result.data as TaskBoardItem;
      setChildren((prev) => [...prev, newTask]);
      addTask(newTask);
      setNewTitle('');
      setIsAdding(false);
      if (!isExpanded) {
        setIsExpanded(true);
        setLoadedChildren(true);
      }
    }
  };

  const handleDeleteChild = async (childId: string) => {
    const result = await deleteTaskAction(childId);
    if (result.success) {
      setChildren((prev) => prev.filter((c) => c.id !== childId));
      removeTask(childId);
    }
  };

  return (
    <div
      className={cn('flex flex-col gap-0.5', depth > 0 && 'ml-3 pl-2 border-l border-white/[0.06]')}
    >
      {/* Row */}
      <div
        className={cn(
          'group flex items-center gap-1 rounded border border-white/[0.06] px-2 py-1.5 transition-colors',
          'bg-white/[0.01] hover:bg-white/[0.03]',
        )}
      >
        {/* Expand chevron — invisible spacer when no children */}
        <button
          onClick={handleToggle}
          className={cn(
            'shrink-0 flex h-4 w-4 items-center justify-center rounded transition-colors',
            'text-muted-foreground/30 hover:text-muted-foreground/60',
            !hasSubtasks && 'pointer-events-none opacity-0',
          )}
          aria-label={isExpanded ? 'Collapse subtasks' : 'Expand subtasks'}
        >
          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>

        {/* Title — navigates to task detail on click */}
        <button
          className="flex-1 min-w-0 text-left text-sm text-foreground/80 hover:text-foreground hover:underline truncate transition-colors"
          onClick={() => selectTask(task.id)}
        >
          {task.title}
        </button>

        {/* Sub-subtask count badge (only when collapsed and has children) */}
        {hasSubtasks && !isExpanded && (
          <span
            className="shrink-0 tabular-nums text-[10px] text-muted-foreground/30 cursor-pointer hover:text-muted-foreground/60 transition-colors"
            onClick={handleToggle}
            title={`${task.subtaskTotal} subtask${task.subtaskTotal !== 1 ? 's' : ''}`}
          >
            {task.subtaskTotal}↓
          </span>
        )}

        {/* Status badge */}
        <Badge variant="outline" className="shrink-0 h-4 px-1.5 text-[10px]">
          {task.status}
        </Badge>

        {/* Add sub-subtask — revealed on hover */}
        <button
          className={cn(
            'shrink-0 flex h-5 w-5 items-center justify-center rounded transition-all',
            'text-muted-foreground/0 hover:text-muted-foreground/60',
            'group-hover:text-muted-foreground/35 hover:bg-white/[0.06]',
          )}
          onClick={async () => {
            setIsAdding(true);
            if (!isExpanded) {
              if (!loadedChildren) await loadChildren();
              setIsExpanded(true);
            }
          }}
          title="Add sub-subtask"
          aria-label="Add sub-subtask"
        >
          <GitBranch className="h-3 w-3" />
        </button>

        {/* Delete */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'shrink-0 h-5 w-5 transition-all',
            'text-muted-foreground/0 hover:text-destructive',
            'group-hover:text-muted-foreground/35',
          )}
          onClick={() => onDelete(task.id)}
          aria-label="Delete subtask"
        >
          <XIcon className="h-3 w-3" />
        </Button>
      </div>

      {/* Expanded children */}
      {isExpanded && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {children.map((child) => (
            <SubtaskRow
              key={child.id}
              task={child}
              depth={depth + 1}
              projectId={projectId}
              onDelete={handleDeleteChild}
            />
          ))}

          {/* Add sub-subtask inline input */}
          {isAdding && (
            <div className="ml-3 pl-2 border-l border-white/[0.06] flex gap-1.5 items-center mt-0.5">
              <Input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Sub-subtask title…"
                className="h-7 text-xs"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddChild();
                  if (e.key === 'Escape') setIsAdding(false);
                }}
              />
              <Button
                size="sm"
                className="h-7 text-xs px-2 shrink-0"
                onClick={() => void handleAddChild()}
              >
                Add
              </Button>
            </div>
          )}

          {/* Placeholder when no children yet */}
          {children.length === 0 && !isAdding && loadedChildren && (
            <p className="ml-3 pl-2 border-l border-white/[0.06] text-[11px] text-muted-foreground/30 py-1">
              No sub-subtasks
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── TaskSubtasksList ─────────────────────────────────────── */

interface TaskSubtasksListProps {
  taskId: string;
}

export function TaskSubtasksList({ taskId }: TaskSubtasksListProps) {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const removeTask = useTaskBoardStore((s) => s.removeTask);
  const updateTask = useTaskBoardStore((s) => s.updateTask);
  const parentTask = useTaskBoardStore((s) => s.tasksById[taskId]);
  const { data: fetchedSubtasks } = useFetch<TaskBoardItem[]>(`/api/tasks/${taskId}/subtasks`, {
    transform: (json: unknown) => (json as { data: TaskBoardItem[] }).data ?? [],
  });
  const [optimisticAdds, setOptimisticAdds] = useState<TaskBoardItem[]>([]);
  const [optimisticRemoveIds, setOptimisticRemoveIds] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  // Merge fetched data with optimistic local changes
  const subtasks = useMemo(() => {
    const base = (fetchedSubtasks ?? []).filter((s) => !optimisticRemoveIds.has(s.id));
    return [...base, ...optimisticAdds.filter((a) => !base.some((b) => b.id === a.id))];
  }, [fetchedSubtasks, optimisticAdds, optimisticRemoveIds]);

  const handleAdd = async () => {
    if (!newTitle.trim()) return;

    const result = await createTaskAction({
      title: newTitle.trim(),
      parentTaskId: taskId,
      projectId: parentTask?.projectId ?? undefined,
    });

    if (result.success) {
      const newTask = result.data as TaskBoardItem;
      setOptimisticAdds((prev) => [...prev, newTask]);
      addTask(newTask);
      setNewTitle('');
      setIsAdding(false);
    }
  };

  const handleDelete = async (subId: string) => {
    const result = await deleteTaskAction(subId);
    if (result.success) {
      setOptimisticRemoveIds((prev) => new Set([...prev, subId]));
      removeTask(subId);
    }
  };

  const allDone =
    subtasks.length > 0 && subtasks.every((s) => s.status === 'done' || s.status === 'cancelled');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Subtasks</h3>
        <Button variant="ghost" size="sm" onClick={() => setIsAdding(true)}>
          + Add
        </Button>
      </div>

      {subtasks.map((sub) => (
        <SubtaskRow
          key={sub.id}
          task={sub}
          depth={0}
          projectId={parentTask?.projectId}
          onDelete={handleDelete}
        />
      ))}

      {subtasks.length === 0 && !isAdding && (
        <p className="text-sm text-muted-foreground">No subtasks</p>
      )}

      {isAdding && (
        <div className="flex gap-2">
          <Input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Subtask title..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd();
              if (e.key === 'Escape') setIsAdding(false);
            }}
          />
          <Button size="sm" onClick={() => void handleAdd()}>
            Add
          </Button>
        </div>
      )}

      {allDone && (
        <div className="flex items-center justify-between rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
          <span className="text-xs text-emerald-400/80">All subtasks complete</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs text-emerald-400 hover:text-emerald-300"
            onClick={async () => {
              const r = await updateTaskStatusAction(taskId, 'done');
              if (r.success) updateTask(r.data as Task);
            }}
          >
            Mark parent done
          </Button>
        </div>
      )}
    </div>
  );
}
