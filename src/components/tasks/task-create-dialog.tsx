'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { Plus } from 'lucide-react';
import type { Task } from '@/lib/types';

export function TaskCreateDialog() {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('3');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsPending(true);
    setError(null);

    const result = await createTaskAction({
      title: title.trim(),
      description: description.trim() || undefined,
      priority: parseInt(priority, 10),
    });

    if (result.success) {
      addTask(result.data as Task);
      setTitle('');
      setDescription('');
      setPriority('3');
      setOpen(false);
    } else {
      setError(result.error);
    }

    setIsPending(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" />
          New Task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            required
          />

          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
          />

          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Critical</SelectItem>
              <SelectItem value="2">High</SelectItem>
              <SelectItem value="3">Medium</SelectItem>
              <SelectItem value="4">Low</SelectItem>
              <SelectItem value="5">Lowest</SelectItem>
            </SelectContent>
          </Select>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={isPending || !title.trim()}>
            {isPending ? 'Creating...' : 'Create Task'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
