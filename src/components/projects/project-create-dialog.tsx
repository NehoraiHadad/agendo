'use client';

import { useState } from 'react';
import { Folder, Loader2, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { Project } from '@/lib/types';

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

interface DiscoveredProject {
  path: string;
  name: string;
  type: 'git' | 'node' | 'python' | 'rust' | 'go' | 'other';
}

interface ProjectCreateDialogProps {
  onCreated: (project: Project) => void;
}

export function ProjectCreateDialog({ onCreated }: ProjectCreateDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [icon, setIcon] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [suggestions, setSuggestions] = useState<DiscoveredProject[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  function reset() {
    setName('');
    setRootPath('');
    setDescription('');
    setColor(PRESET_COLORS[0]);
    setIcon('');
    setError(null);
    setSuggestions([]);
    setShowSuggestions(false);
  }

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

  function handleSelectSuggestion(suggestion: DiscoveredProject) {
    setRootPath(suggestion.path);
    if (!name.trim()) setName(suggestion.name);
    setShowSuggestions(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch<ApiResponse<Project>>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          rootPath: rootPath.trim(),
          description: description.trim() || undefined,
          color,
          icon: icon.trim() || undefined,
        }),
      });
      onCreated(res.data);
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4 mr-2" />
          New Project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="proj-name">Name</Label>
            <Input
              id="proj-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My App"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="proj-path">Root Path</Label>
            <div className="flex gap-2">
              <Input
                id="proj-path"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="/home/ubuntu/projects/myapp"
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
                            onClick={() => handleSelectSuggestion(s)}
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
            <Label htmlFor="proj-desc">
              Description{' '}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="proj-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description of this project..."
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
            <Label htmlFor="proj-icon">
              Icon{' '}
              <span className="font-normal text-muted-foreground">(optional emoji)</span>
            </Label>
            <Input
              id="proj-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value.slice(0, 2))}
              placeholder="🚀"
              className="w-20"
              maxLength={2}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={!name.trim() || !rootPath.trim() || isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Plus className="size-4 mr-2" />
              )}
              Create Project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
