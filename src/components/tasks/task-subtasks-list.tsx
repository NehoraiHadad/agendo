'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import type { Task } from '@/lib/types';

interface TaskSubtasksListProps {
  taskId: string;
}

export function TaskSubtasksList({ taskId }: TaskSubtasksListProps) {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    fetch(`/api/tasks?parentTaskId=${taskId}`)
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
          <span className="text-sm">{sub.title}</span>
          <Badge variant="outline" className="text-xs">
            {sub.status}
          </Badge>
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
    </div>
  );
}
