'use client';

import { useState } from 'react';
import { ArchiveRestore, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { Project } from '@/lib/types';

interface DeletedProjectCardProps {
  project: Project;
  onRestored: (project: Project) => void;
  onPurged: (id: string) => void;
}

export function DeletedProjectCard({ project, onRestored, onPurged }: DeletedProjectCardProps) {
  const [isRestoring, setIsRestoring] = useState(false);
  const [isPurging, setIsPurging] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleteTasks, setDeleteTasks] = useState(false);

  async function handleRestore() {
    setIsRestoring(true);
    try {
      const res = await apiFetch<ApiResponse<Project>>(`/api/projects/${project.id}/restore`, {
        method: 'POST',
      });
      onRestored(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restore project');
    } finally {
      setIsRestoring(false);
    }
  }

  async function handlePurge() {
    setIsPurging(true);
    const url = deleteTasks
      ? `/api/projects/${project.id}/purge?withTasks=true`
      : `/api/projects/${project.id}/purge`;
    try {
      await apiFetch(url, { method: 'DELETE' });
      onPurged(project.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete project');
      setIsPurging(false);
    }
  }

  function handleCancelConfirm() {
    setShowConfirm(false);
    setDeleteTasks(false);
  }

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-4 flex flex-col gap-3 opacity-70">
      <div className="flex items-start gap-2">
        <Trash2 className="size-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-muted-foreground truncate">{project.name}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">{project.rootPath}</p>
        </div>
      </div>

      {!showConfirm ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={isRestoring || isPurging}
            onClick={handleRestore}
          >
            {isRestoring ? (
              <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            ) : (
              <ArchiveRestore className="size-3.5 mr-1.5" />
            )}
            Restore
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="flex-1 text-destructive hover:text-destructive hover:bg-destructive/10"
            disabled={isRestoring || isPurging}
            onClick={() => setShowConfirm(true)}
          >
            <Trash2 className="size-3.5 mr-1.5" />
            Delete forever
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Permanently delete <span className="font-semibold text-foreground">{project.name}</span>? This cannot be undone.
          </p>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`delete-tasks-${project.id}`}
              checked={deleteTasks}
              onCheckedChange={(checked) => setDeleteTasks(checked === true)}
              disabled={isPurging}
            />
            <Label
              htmlFor={`delete-tasks-${project.id}`}
              className="text-xs text-muted-foreground cursor-pointer"
            >
              Also delete linked tasks
            </Label>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={isPurging}
              onClick={handleCancelConfirm}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="flex-1"
              disabled={isPurging}
              onClick={handlePurge}
            >
              {isPurging && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
              Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
