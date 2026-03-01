'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  Plus,
  FileText,
  FolderOpen,
  CalendarDays,
  Search,
  Loader2,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { PlanStatusBadge } from '@/components/plans/plan-status-badge';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { Plan, PlanStatus, Project } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ALL_STATUSES: PlanStatus[] = ['draft', 'ready', 'stale', 'executing', 'done', 'archived'];

// ---------------------------------------------------------------------------
// PlanCard
// ---------------------------------------------------------------------------

interface PlanCardProps {
  plan: Plan;
  projectName: string | undefined;
}

function PlanCard({ plan, projectName }: PlanCardProps) {
  const preview = plan.content
    .slice(0, 120)
    .replace(/^#+\s*/gm, '')
    .replace(/\n/g, ' ')
    .trim();
  const hasMore = plan.content.length > 120;

  return (
    <Link
      href={`/plans/${plan.id}`}
      className="group relative flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover:border-white/[0.12] hover:bg-white/[0.04] transition-all duration-150 no-underline min-h-[140px]"
    >
      {/* Status accent left bar */}
      <span
        className={cn(
          'absolute left-0 top-4 bottom-4 w-0.5 rounded-r-full opacity-60',
          plan.status === 'draft' && 'bg-zinc-400',
          plan.status === 'ready' && 'bg-blue-400',
          plan.status === 'stale' && 'bg-amber-400',
          plan.status === 'executing' && 'bg-violet-400',
          plan.status === 'done' && 'bg-emerald-400',
          plan.status === 'archived' && 'bg-zinc-600',
        )}
      />

      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground/90 truncate group-hover:text-foreground transition-colors leading-snug">
            {plan.title}
          </p>
        </div>
        <PlanStatusBadge status={plan.status} className="shrink-0" />
      </div>

      {/* Content preview */}
      {preview && (
        <p className="text-xs text-muted-foreground/55 leading-relaxed line-clamp-2 font-mono">
          {preview}
          {hasMore && <span className="text-muted-foreground/30">…</span>}
        </p>
      )}

      {/* Footer meta */}
      <div className="mt-auto flex items-center gap-3 text-[10px] text-muted-foreground/40 flex-wrap">
        {projectName && (
          <span className="flex items-center gap-1">
            <FolderOpen className="size-3" />
            {projectName}
          </span>
        )}
        <span className="flex items-center gap-1" suppressHydrationWarning>
          <CalendarDays className="size-3" />
          {formatDistanceToNow(new Date(plan.createdAt), { addSuffix: true })}
        </span>
        {plan.lastValidatedAt && (
          <span className="text-muted-foreground/30" suppressHydrationWarning>
            validated {formatDistanceToNow(new Date(plan.lastValidatedAt), { addSuffix: true })}
          </span>
        )}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// New Plan dialog
// ---------------------------------------------------------------------------

interface NewPlanDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projects: Project[];
  onCreated: (plan: Plan) => void;
}

function NewPlanDialog({ open, onOpenChange, projects, onCreated }: NewPlanDialogProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!title.trim() || !projectId || isCreating) return;
    setIsCreating(true);
    setError(null);
    try {
      const result = await apiFetch<ApiResponse<Plan>>('/api/plans', {
        method: 'POST',
        body: JSON.stringify({ projectId, title: title.trim(), content }),
      });
      onCreated(result.data);
      setTitle('');
      setContent('');
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create plan');
      setIsCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!isCreating) onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Plan</DialogTitle>
          <DialogDescription>
            Create a new implementation plan. You can edit the content after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">Project</label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-full border-white/[0.08] bg-white/[0.04]">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">Title</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) void handleCreate();
              }}
              placeholder="e.g. Implement user authentication"
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm focus:outline-none focus:border-primary/40 placeholder:text-muted-foreground/30"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">
              Initial content{' '}
              <span className="text-muted-foreground/40 font-normal">(optional)</span>
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              placeholder="Describe the plan steps in markdown..."
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary/40 placeholder:text-muted-foreground/30 resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={isCreating || !title.trim() || !projectId}
            className="gap-1.5"
          >
            {isCreating ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
            Create Plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// PlansListClient
// ---------------------------------------------------------------------------

interface PlansListClientProps {
  plans: Plan[];
  projects: Project[];
}

export function PlansListClient({ plans: initialPlans, projects }: PlansListClientProps) {
  const router = useRouter();
  const [plans, setPlans] = useState<Plan[]>(initialPlans);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [newPlanOpen, setNewPlanOpen] = useState(false);

  // Build a project name lookup
  const projectNameMap = Object.fromEntries(projects.map((p) => [p.id, p.name]));

  const handlePlanCreated = useCallback(
    (plan: Plan) => {
      setPlans((prev) => [plan, ...prev]);
      router.push(`/plans/${plan.id}`);
    },
    [router],
  );

  // Client-side filtering — archived plans are hidden by default (only shown when explicitly selected)
  const filtered = plans.filter((plan) => {
    if (statusFilter === 'all' && plan.status === 'archived') return false;
    if (statusFilter !== 'all' && plan.status !== statusFilter) return false;
    if (projectFilter !== 'all' && plan.projectId !== projectFilter) return false;
    if (
      searchQuery.trim() &&
      !plan.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !plan.content.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  const activeCount = plans.filter((p) => p.status === 'executing').length;
  const readyCount = plans.filter((p) => p.status === 'ready').length;

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Plans</h1>
          <p className="text-sm text-muted-foreground/60 mt-1">
            Implementation plans for agent execution
            {(activeCount > 0 || readyCount > 0) && (
              <span className="ml-2 text-muted-foreground/40">
                {activeCount > 0 && (
                  <span className="text-violet-400">
                    {activeCount} executing
                    {readyCount > 0 && ' · '}
                  </span>
                )}
                {readyCount > 0 && <span className="text-blue-400">{readyCount} ready</span>}
              </span>
            )}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setNewPlanOpen(true)}
          className="gap-2 shrink-0"
          disabled={projects.length === 0}
        >
          <Plus className="size-4" />
          New Plan
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/40 pointer-events-none" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search plans..."
            className="w-full h-9 rounded-lg border border-white/[0.08] bg-white/[0.04] pl-9 pr-3 text-sm focus:outline-none focus:border-primary/40 placeholder:text-muted-foreground/30"
          />
        </div>

        <div className="flex items-center gap-2">
          <SlidersHorizontal className="size-3.5 text-muted-foreground/30 shrink-0" />

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px] border-white/[0.08] bg-white/[0.04] h-9">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {ALL_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {projects.length > 1 && (
            <Select value={projectFilter} onValueChange={setProjectFilter}>
              <SelectTrigger className="w-[160px] border-white/[0.08] bg-white/[0.04] h-9">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {filtered.length !== plans.length && (
          <span className="text-xs text-muted-foreground/40">
            {filtered.length} of {plans.length}
          </span>
        )}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-4 rounded-xl border border-white/[0.04] border-dashed">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl"
            style={{
              background:
                'linear-gradient(135deg, oklch(0.7 0.18 280 / 0.08) 0%, oklch(0.6 0.2 260 / 0.04) 100%)',
              border: '1px solid oklch(0.7 0.18 280 / 0.12)',
            }}
          >
            <FileText className="size-5 text-muted-foreground/40" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-foreground/60">
              {plans.length === 0 ? 'No plans yet' : 'No matching plans'}
            </p>
            <p className="text-xs text-muted-foreground/40 mt-1">
              {plans.length === 0
                ? 'Create your first plan to get started'
                : 'Try adjusting your filters'}
            </p>
          </div>
          {plans.length === 0 && projects.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNewPlanOpen(true)}
              className="gap-2 border-white/[0.08]"
            >
              <Plus className="size-3.5" />
              Create Plan
            </Button>
          )}
        </div>
      )}

      {/* Card grid */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((plan) => (
            <PlanCard key={plan.id} plan={plan} projectName={projectNameMap[plan.projectId]} />
          ))}
        </div>
      )}

      {/* New plan dialog */}
      <NewPlanDialog
        open={newPlanOpen}
        onOpenChange={setNewPlanOpen}
        projects={projects}
        onCreated={handlePlanCreated}
      />
    </div>
  );
}
