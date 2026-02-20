'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createTaskAction, deleteTaskAction, updateTaskStatusAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { X as XIcon } from 'lucide-react';
import type { Task } from '@/lib/types';

interface TaskSubtasksListProps {
  taskId: string;
}

export function TaskSubtasksList({ taskId }: TaskSubtasksListProps) {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const removeTask = useTaskBoardStore((s) => s.removeTask);
  const selectTask = useTaskBoardStore((s) => s.selectTask);
  const updateTask = useTaskBoardStore((s) => s.updateTask);
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    fetch(`/api/tasks/${taskId}/subtasks`)
      .then((res) => res.json())
      .then((json) => setSubtasks(json.data ?? []))
      .catch(() => {});
  }, [taskId]);

  const handleAdd = async () => {
    if (!newTitle.trim()) return;

    const result = await createTaskAction({
      title: newTitle.trim(),
      parentTaskId: taskId,
    });

    if (result.success) {
      const newTask = result.data as Task;
      setSubtasks((prev) => [...prev, newTask]);
      addTask(newTask);
      setNewTitle('');
      setIsAdding(false);
    }
  };

  const handleDelete = async (subId: string) => {
    const result = await deleteTaskAction(subId);
    if (result.success) {
      setSubtasks((prev) => prev.filter((s) => s.id !== subId));
      removeTask(subId);
    }
  };

  const allDone =
    subtasks.length > 0 &&
    subtasks.every((s) => s.status === 'done' || s.status === 'cancelled');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Subtasks</h3>
        <Button variant="ghost" size="sm" onClick={() => setIsAdding(true)}>
          + Add
        </Button>
      </div>

      {subtasks.map((sub) => (
        <div key={sub.id} className="flex items-center justify-between rounded border px-3 py-2">
          <button
            className="flex-1 text-left text-sm hover:underline"
            onClick={() => selectTask(sub.id)}
          >
            {sub.title}
          </button>
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="text-xs">
              {sub.status}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleDelete(sub.id)}
            >
              <XIcon className="h-3 w-3" />
            </Button>
          </div>
        </div>
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
              if (e.key === 'Enter') handleAdd();
              if (e.key === 'Escape') setIsAdding(false);
            }}
          />
          <Button size="sm" onClick={handleAdd}>
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
