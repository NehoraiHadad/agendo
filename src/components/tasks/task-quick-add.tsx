'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { Plus } from 'lucide-react';
import type { Task, TaskStatus } from '@/lib/types';

interface TaskQuickAddProps {
  status: TaskStatus;
}

export function TaskQuickAdd({ status }: TaskQuickAddProps) {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const [isActive, setIsActive] = useState(false);
  const [title, setTitle] = useState('');
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || isPending) return;

    setIsPending(true);
    const result = await createTaskAction({
      title: title.trim(),
      status,
    });

    if (result.success) {
      addTask(result.data as Task);
      setTitle('');
    }

    setIsPending(false);
  };

  if (!isActive) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="m-2 justify-start text-xs text-muted-foreground"
        onClick={() => setIsActive(true)}
      >
        <Plus className="mr-1 h-3 w-3" />
        Add task
      </Button>
    );
  }

  return (
    <div className="m-2 flex gap-2">
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title..."
        className="h-8 text-sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') {
            setIsActive(false);
            setTitle('');
          }
        }}
        onBlur={() => {
          if (!title.trim()) {
            setIsActive(false);
          }
        }}
      />
      <Button
        size="sm"
        className="h-8"
        onClick={handleSubmit}
        disabled={isPending || !title.trim()}
      >
        Add
      </Button>
    </div>
  );
}
