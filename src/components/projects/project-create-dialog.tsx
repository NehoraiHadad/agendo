'use client';

import { useState, useEffect, useRef } from 'react';
import { useDraft } from '@/hooks/use-draft';
import { useFormSubmit } from '@/hooks/use-form-submit';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderPlus,
  GitBranch,
  Loader2,
  Plus,
  Search,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
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
import { ErrorAlert } from '@/components/ui/error-alert';
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

interface BrowsedDirectory extends DiscoveredProject {
  isProjectLike: boolean;
  isRegistered: boolean;
}

interface BrowseData {
  currentPath: string | null;
  parentPath: string | null;
  roots: string[];
  currentPathRegistered: boolean;
  entries: BrowsedDirectory[];
}

type PathStatus = 'idle' | 'checking' | 'exists' | 'creatable' | 'denied';

interface ProjectCreateDialogProps {
  onCreated: (project: Project) => void;
}

function slugifyProjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function ProjectCreateDialog({ onCreated }: ProjectCreateDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [icon, setIcon] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [suggestions, setSuggestions] = useState<DiscoveredProject[]>([]);
  const [browseData, setBrowseData] = useState<BrowseData | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [pathStatus, setPathStatus] = useState<PathStatus>('idle');
  const [pathDeniedReason, setPathDeniedReason] = useState('');
  const [detectedRepo, setDetectedRepo] = useState<string | null>(null);
  const [createDir, setCreateDir] = useState(false);
  const checkAbortRef = useRef<AbortController | null>(null);

  const { saveDraft, getDraft, clearDraft } = useDraft('draft:project:new');
  const {
    isSubmitting,
    error,
    setError,
    handleSubmit: submitForm,
  } = useFormSubmit(async () => {
    const res = await apiFetch<ApiResponse<Project>>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim(),
        rootPath: rootPath.trim(),
        description: description.trim() || undefined,
        color,
        icon: icon.trim() || undefined,
        createDir: pathStatus === 'creatable' && createDir,
      }),
    });
    onCreated(res.data);
    clearDraft();
    reset();
    setOpen(false);
  });

  function saveCombinedDraft(nextName = name, nextDescription = description) {
    saveDraft(JSON.stringify({ name: nextName, description: nextDescription }));
  }

  function reset() {
    setName('');
    setRootPath('');
    setDescription('');
    setColor(PRESET_COLORS[0]);
    setIcon('');
    setError(null);
    setSuggestions([]);
    setBrowseData(null);
    setShowSuggestions(false);
    setShowBrowser(false);
    setPathStatus('idle');
    setPathDeniedReason('');
    setDetectedRepo(null);
    setCreateDir(false);
  }

  // Debounced path check + GitHub repo detection
  useEffect(() => {
    if (!rootPath || !rootPath.startsWith('/')) {
      setPathStatus('idle');
      setPathDeniedReason('');
      setDetectedRepo(null);
      setCreateDir(false);
      return;
    }

    setPathStatus('checking');
    const timer = setTimeout(async () => {
      checkAbortRef.current?.abort();
      const controller = new AbortController();
      checkAbortRef.current = controller;

      try {
        const res = await fetch(`/api/projects/check-path?path=${encodeURIComponent(rootPath)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Check failed');
        const json = (await res.json()) as {
          data: { status: PathStatus; reason?: string };
        };
        setPathStatus(json.data.status);
        setPathDeniedReason(json.data.reason ?? '');
        if (json.data.status !== 'creatable') {
          setCreateDir(false);
        }

        // Auto-detect GitHub repo when path exists
        if (json.data.status === 'exists') {
          try {
            const ghRes = await fetch('/api/integrations/github', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'detect-repo', rootPath }),
              signal: controller.signal,
            });
            if (ghRes.ok) {
              const ghJson = (await ghRes.json()) as {
                data: { repo: { fullName: string } | null };
              };
              setDetectedRepo(ghJson.data.repo?.fullName ?? null);
            }
          } catch {
            // GitHub detection is optional, don't block
          }
        } else {
          setDetectedRepo(null);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPathStatus('idle');
      }
    }, 500);

    return () => {
      clearTimeout(timer);
    };
  }, [rootPath]);

  async function loadBrowseData(nextPath?: string) {
    setBrowsing(true);
    try {
      const qs = nextPath ? `?path=${encodeURIComponent(nextPath)}` : '';
      const res = await fetch(`/api/projects/browse${qs}`);
      if (!res.ok) throw new Error('Request failed');
      const json = (await res.json()) as { data: BrowseData };
      setBrowseData(json.data);
      setShowBrowser(true);
    } catch {
      toast.error('Failed to browse directories');
    } finally {
      setBrowsing(false);
    }
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
    setCreateDir(false);
    setShowSuggestions(false);
  }

  function handleSelectBrowsePath(nextPath: string) {
    setRootPath(nextPath);
    if (!name.trim()) {
      const segments = nextPath.split('/').filter(Boolean);
      const fallbackName = segments[segments.length - 1];
      if (fallbackName) setName(fallbackName);
    }
    setCreateDir(false);
    setShowBrowser(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;
    await submitForm();
  }

  const suggestedSlug = slugifyProjectName(name);
  const suggestedRoot = browseData?.roots[0] ?? null;
  const suggestedNewPath =
    suggestedRoot && suggestedSlug ? `${suggestedRoot}/${suggestedSlug}` : null;
  const isCreateDisabled =
    !name.trim() ||
    !rootPath.trim() ||
    isSubmitting ||
    pathStatus === 'denied' ||
    pathStatus === 'checking' ||
    (pathStatus === 'creatable' && !createDir);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          const saved = getDraft();
          if (saved) {
            try {
              const parsed = JSON.parse(saved) as { name?: string; description?: string };
              if (parsed.name) setName(parsed.name);
              if (parsed.description) setDescription(parsed.description);
            } catch {
              // ignore malformed draft
            }
          }
          void loadBrowseData();
        } else {
          reset();
        }
      }}
    >
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

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="proj-name">Name</Label>
              <Input
                id="proj-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  saveCombinedDraft(e.target.value);
                }}
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
                  onChange={(e) => {
                    setRootPath(e.target.value);
                  }}
                  placeholder="Absolute path to project root (use Discover to find)"
                  required
                  className="flex-1 font-mono text-sm"
                />
                <Popover
                  open={showBrowser}
                  onOpenChange={(nextOpen) => {
                    setShowBrowser(nextOpen);
                    if (nextOpen && !browseData && !browsing) {
                      void loadBrowseData();
                    }
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => void loadBrowseData(browseData?.currentPath ?? undefined)}
                      disabled={browsing}
                      aria-label="Browse directories"
                      className="shrink-0"
                    >
                      {browsing ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Folder className="size-3.5" />
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-96 p-1" align="end">
                    <div className="border-b border-border/60 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {browseData?.currentPath ? 'Browse Folders' : 'Allowed Roots'}
                          </p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {browseData?.currentPath ?? 'Choose where to start browsing'}
                          </p>
                        </div>
                        {browseData?.parentPath && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 shrink-0"
                            onClick={() => void loadBrowseData(browseData.parentPath ?? undefined)}
                            aria-label="Go to parent directory"
                          >
                            <ChevronLeft className="size-4" />
                          </Button>
                        )}
                      </div>
                      {browseData?.currentPath && (
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleSelectBrowsePath(browseData.currentPath ?? '')}
                            disabled={browseData.currentPathRegistered}
                          >
                            Use Current Folder
                          </Button>
                          {browseData.currentPathRegistered && (
                            <span className="text-xs text-muted-foreground">
                              Already added as a project
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {!browseData ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                        Loading folders...
                      </p>
                    ) : browseData.entries.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                        No folders found here
                      </p>
                    ) : (
                      <ul
                        className="max-h-72 overflow-y-auto"
                        onTouchMove={(e) => e.stopPropagation()}
                      >
                        {browseData.entries.map((entry) => (
                          <li key={entry.path} className="flex items-center gap-1 px-1 py-1">
                            <button
                              type="button"
                              onClick={() => handleSelectBrowsePath(entry.path)}
                              disabled={entry.isRegistered}
                              className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus:outline-none focus:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Folder className="size-4 shrink-0 text-muted-foreground" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="truncate font-medium">{entry.name}</p>
                                  {entry.type !== 'other' && (
                                    <Badge variant="secondary" className="uppercase">
                                      {entry.type}
                                    </Badge>
                                  )}
                                  {entry.isRegistered && <Badge variant="outline">Added</Badge>}
                                </div>
                                <p className="truncate font-mono text-xs text-muted-foreground">
                                  {entry.path}
                                </p>
                              </div>
                            </button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-8 shrink-0"
                              onClick={() => void loadBrowseData(entry.path)}
                              aria-label={`Browse inside ${entry.name}`}
                            >
                              <ChevronRight className="size-4" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </PopoverContent>
                </Popover>
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
                      <ul
                        className="max-h-60 overflow-y-auto"
                        onTouchMove={(e) => e.stopPropagation()}
                      >
                        {suggestions.map((s) => (
                          <li key={s.path}>
                            <button
                              type="button"
                              onClick={() => handleSelectSuggestion(s)}
                              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus:outline-none focus:bg-accent"
                            >
                              <Folder className="size-4 shrink-0 text-muted-foreground" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="truncate font-medium">{s.name}</p>
                                  <Badge variant="secondary" className="uppercase">
                                    {s.type}
                                  </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground font-mono truncate">
                                  {s.path}
                                </p>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
              {suggestedNewPath && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setRootPath(suggestedNewPath);
                    setCreateDir(true);
                  }}
                >
                  <FolderPlus className="mr-1 size-3.5" />
                  New folder: {suggestedNewPath}
                </Button>
              )}
              {/* Path status indicator */}
              {pathStatus === 'checking' && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Checking path...
                </p>
              )}
              {pathStatus === 'exists' && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Check className="size-3" />
                  Directory exists
                </p>
              )}
              {pathStatus === 'creatable' && (
                <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-3">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="proj-create-dir"
                      checked={createDir}
                      onCheckedChange={(checked) => setCreateDir(checked === true)}
                    />
                    <div className="space-y-1">
                      <Label htmlFor="proj-create-dir" className="text-sm">
                        Create this directory on disk
                      </Label>
                      <p className="flex items-center gap-1.5 text-xs text-blue-400">
                        <FolderPlus className="size-3" />
                        Folder does not exist yet.
                      </p>
                      <p className="font-mono text-[11px] text-muted-foreground">{rootPath}</p>
                    </div>
                  </div>
                </div>
              )}
              {pathStatus === 'denied' && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <XCircle className="size-3" />
                  {pathDeniedReason || 'Path not allowed'}
                </p>
              )}
              {detectedRepo && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-400">
                  <GitBranch className="size-3" />
                  GitHub: {detectedRepo}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="proj-desc">
                Description <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="proj-desc"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  saveCombinedDraft(undefined, e.target.value);
                }}
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
                Icon <span className="font-normal text-muted-foreground">(optional emoji)</span>
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

            <ErrorAlert message={error} />
          </DialogBody>

          <DialogFooter>
            <Button type="submit" disabled={isCreateDisabled}>
              {isSubmitting ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : pathStatus === 'creatable' ? (
                <FolderPlus className="size-4 mr-2" />
              ) : (
                <Plus className="size-4 mr-2" />
              )}
              {pathStatus === 'creatable' ? 'Create Project & Directory' : 'Create Project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
