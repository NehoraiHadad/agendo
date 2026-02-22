'use client';

import { useState } from 'react';
import { Folder, Loader2, Pencil, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { Project } from '@/lib/types';

interface DiscoveredProject {
  path: string;
  name: string;
  type: 'git' | 'node' | 'python' | 'rust' | 'go' | 'other';
}

const PRESET_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
];

interface ProjectEditSheetProps {
  project: Project;
  onUpdated: (project: Project) => void;
  onDeleted: (id: string) => void;
}

export function ProjectEditSheet({ project, onUpdated, onDeleted }: ProjectEditSheetProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [rootPath, setRootPath] = useState(project.rootPath);
  const [description, setDescription] = useState(project.description ?? '');
  const [color, setColor] = useState(project.color ?? PRESET_COLORS[0]);
  const [icon, setIcon] = useState(project.icon ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteMode, setDeleteMode] = useState<'archive' | 'purge'>('archive');
  const [deleteTasks, setDeleteTasks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [suggestions, setSuggestions] = useState<DiscoveredProject[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  async function handleDiscover() {
    setDiscovering(true);
    try {
      const res = await fetch('/api/projects/discover');
      if (!res.ok) throw new Error('Request failed');
      const json = (await res.json()) as { data: DiscoveredProject[] };
      setSuggestions(json.data);
      setShowSuggestions(true);
    } catch {
      toast.error('Failed to discover projects');
    } finally {
      setDiscovering(false);
    }
  }

  function resetToProject() {
    setName(project.name);
    setRootPath(project.rootPath);
    setDescription(project.description ?? '');
    setColor(project.color ?? PRESET_COLORS[0]);
    setIcon(project.icon ?? '');
    setError(null);
    setConfirmDelete(false);
    setDeleteMode('archive');
    setDeleteTasks(false);
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch<ApiResponse<Project>>(`/api/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          rootPath: rootPath.trim(),
          description: description.trim() || undefined,
          color,
          icon: icon.trim() || undefined,
        }),
      });
      onUpdated(res.data);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }

    setIsDeleting(true);
    setError(null);

    try {
      if (deleteMode === 'purge') {
        const url = deleteTasks
          ? `/api/projects/${project.id}/purge?withTasks=true`
          : `/api/projects/${project.id}/purge`;
        await apiFetch(url, { method: 'DELETE' });
      } else {
        await apiFetch(`/api/projects/${project.id}`, { method: 'DELETE' });
      }
      onDeleted(project.id);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project');
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetToProject(); }}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Edit project"
        >
          <Pencil className="size-3.5" />
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Edit Project</SheetTitle>
        </SheetHeader>

        <form onSubmit={handleUpdate} className="flex flex-col flex-1 gap-4 p-4 overflow-y-auto">
          <div className="space-y-2">
            <Label htmlFor="edit-name">Name</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-path">Root Path</Label>
            <div className="flex gap-2">
              <Input
                id="edit-path"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                required
                className="flex-1 font-mono text-sm"
              />
              <Popover open={showSuggestions} onOpenChange={setShowSuggestions}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleDiscover}
                    disabled={discovering}
                    aria-label="Discover projects"
                    className="shrink-0"
                  >
                    {discovering ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Search className="size-3.5" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-1" align="end">
                  {suggestions.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                      No new projects found
                    </p>
                  ) : (
                    <ul className="max-h-60 overflow-y-auto" onTouchMove={(e) => e.stopPropagation()}>
                      {suggestions.map((s) => (
                        <li key={s.path}>
                          <button
                            type="button"
                            onClick={() => { setRootPath(s.path); setShowSuggestions(false); }}
                            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus:outline-none focus:bg-accent"
                          >
                            <Folder className="size-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <p className="font-medium truncate">{s.name}</p>
                              <p className="text-xs text-muted-foreground font-mono truncate">{s.path}</p>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-desc">
              Description{' '}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="edit-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[72px] resize-none"
            />
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex gap-2 flex-wrap">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className="size-7 rounded-full ring-offset-2 ring-offset-background transition-all focus:outline-none focus:ring-2 focus:ring-ring"
                  style={{
                    backgroundColor: c,
                    outline: color === c ? `2px solid ${c}` : undefined,
                    outlineOffset: color === c ? '2px' : undefined,
                  }}
                  aria-label={`Select color ${c}`}
                  aria-pressed={color === c}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-icon">
              Icon{' '}
              <span className="font-normal text-muted-foreground">(optional emoji)</span>
            </Label>
            <Input
              id="edit-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value.slice(0, 2))}
              placeholder="🚀"
              className="w-20"
              maxLength={2}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <SheetFooter className="flex-col gap-2 mt-auto p-0">
            <Button
              type="submit"
              disabled={!name.trim() || !rootPath.trim() || isSubmitting || isDeleting}
            >
              {isSubmitting && <Loader2 className="size-4 mr-2 animate-spin" />}
              Update Project
            </Button>

            {confirmDelete ? (
              <div className="w-full space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-sm font-medium">
                  Delete &ldquo;{project.name}&rdquo;?
                </p>
                <RadioGroup
                  value={deleteMode}
                  onValueChange={(v) => setDeleteMode(v as 'archive' | 'purge')}
                  className="gap-2"
                >
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="archive" id="delete-mode-archive" className="mt-0.5" />
                    <Label htmlFor="delete-mode-archive" className="cursor-pointer space-y-0.5">
                      <span className="text-sm font-medium">Archive (recoverable)</span>
                      <p className="text-xs text-muted-foreground font-normal">
                        Tasks will be hidden but preserved.
                      </p>
                    </Label>
                  </div>
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="purge" id="delete-mode-purge" className="mt-0.5" />
                    <Label htmlFor="delete-mode-purge" className="cursor-pointer space-y-0.5">
                      <span className="text-sm font-medium">Delete permanently</span>
                      <p className="text-xs text-muted-foreground font-normal">
                        Cannot be undone.
                      </p>
                    </Label>
                  </div>
                </RadioGroup>
                {deleteMode === 'purge' && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="delete-tasks-sheet"
                      checked={deleteTasks}
                      onCheckedChange={(checked) => setDeleteTasks(checked === true)}
                      disabled={isDeleting}
                    />
                    <Label htmlFor="delete-tasks-sheet" className="text-xs cursor-pointer">
                      Also delete all linked tasks
                    </Label>
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    disabled={isDeleting}
                    onClick={() => {
                      setConfirmDelete(false);
                      setDeleteMode('archive');
                      setDeleteTasks(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    disabled={isDeleting}
                    onClick={handleDelete}
                  >
                    {isDeleting && <Loader2 className="size-4 mr-1.5 animate-spin" />}
                    Confirm
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="destructive"
                disabled={isSubmitting || isDeleting}
                onClick={handleDelete}
                className="w-full"
              >
                <Trash2 className="size-4 mr-2" />
                Delete Project
              </Button>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
