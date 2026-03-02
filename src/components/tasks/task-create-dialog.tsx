'use client';

import { useState } from 'react';
import { useDraft } from '@/hooks/use-draft';
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
  const projectsById = useTaskBoardStore((s) => s.projectsById);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('3');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('none');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projects = Object.values(projectsById);

  const { saveDraft, getDraft, clearDraft } = useDraft('draft:task:new');

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      // Restore title + description from draft when dialog opens (event handler — not an effect)
      const saved = getDraft();
      if (!saved) return;
      try {
        const parsed = JSON.parse(saved) as { title?: string; description?: string };
        if (parsed.title) setTitle(parsed.title);
        if (parsed.description) setDescription(parsed.description);
      } catch {
        // ignore malformed draft
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsPending(true);
    setError(null);

    const result = await createTaskAction({
      title: title.trim(),
      description: description.trim() || undefined,
      priority: parseInt(priority, 10),
      projectId: selectedProjectId !== 'none' ? selectedProjectId : undefined,
    });

    if (result.success) {
      addTask(result.data as Task);
      clearDraft();
      setTitle('');
      setDescription('');
      setPriority('3');
      setSelectedProjectId('none');
      setOpen(false);
    } else {
      setError(result.error);
    }

    setIsPending(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
            onChange={(e) => {
              setTitle(e.target.value);
              saveDraft(JSON.stringify({ title: e.target.value, description }));
            }}
            placeholder="Task title"
            required
          />

          <Textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              saveDraft(JSON.stringify({ title, description: e.target.value }));
            }}
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

          {projects.length > 0 && (
            <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="No project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No project</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={isPending || !title.trim()}>
            {isPending ? 'Creating...' : 'Create Task'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
