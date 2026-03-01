'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowLeft,
  Eye,
  Pencil,
  Check,
  X,
  FolderOpen,
  CalendarDays,
  Clock,
  Columns2,
  AlignLeft,
  Loader2,
  ExternalLink,
  ChevronDown,
  Archive,
} from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PlanActions } from '@/components/plans/plan-actions';
import { PlanConversationPanel } from '@/components/plans/plan-conversation-panel';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { Plan, PlanStatus, Project } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type ViewMode = 'edit' | 'preview' | 'split';

const PLAN_STATUS_CONFIG: Record<
  PlanStatus,
  { label: string; dotColor: string; pillBg: string; pillBorder: string; textColor: string; pulse: boolean }
> = {
  draft:     { label: 'Draft',     dotColor: 'bg-zinc-400',    pillBg: 'bg-zinc-500/10',    pillBorder: 'border-zinc-500/20',    textColor: 'text-zinc-400',    pulse: false },
  ready:     { label: 'Ready',     dotColor: 'bg-blue-400',    pillBg: 'bg-blue-500/10',    pillBorder: 'border-blue-500/25',    textColor: 'text-blue-400',    pulse: false },
  stale:     { label: 'Stale',     dotColor: 'bg-amber-400',   pillBg: 'bg-amber-500/10',   pillBorder: 'border-amber-500/25',   textColor: 'text-amber-400',   pulse: false },
  executing: { label: 'Executing', dotColor: 'bg-violet-400',  pillBg: 'bg-violet-500/10',  pillBorder: 'border-violet-500/25',  textColor: 'text-violet-400',  pulse: true  },
  done:      { label: 'Done',      dotColor: 'bg-emerald-400', pillBg: 'bg-emerald-500/10', pillBorder: 'border-emerald-500/25', textColor: 'text-emerald-400', pulse: false },
  archived:  { label: 'Archived',  dotColor: 'bg-zinc-600',    pillBg: 'bg-zinc-700/10',    pillBorder: 'border-zinc-700/20',    textColor: 'text-zinc-500',    pulse: false },
};

const STATUS_ACCENT: Record<PlanStatus, string> = {
  draft:     'linear-gradient(90deg, oklch(0.5 0 0 / 0.25) 0%, transparent 70%)',
  ready:     'linear-gradient(90deg, oklch(0.6 0.18 250 / 0.7) 0%, transparent 70%)',
  stale:     'linear-gradient(90deg, oklch(0.65 0.14 85 / 0.6) 0%, transparent 70%)',
  executing: 'linear-gradient(90deg, oklch(0.65 0.2 280 / 0.85) 0%, transparent 70%)',
  done:      'linear-gradient(90deg, oklch(0.65 0.2 145 / 0.7) 0%, transparent 70%)',
  archived:  'linear-gradient(90deg, oklch(0.35 0 0 / 0.2) 0%, transparent 70%)',
};

// ---------------------------------------------------------------------------
// PlanStatusSelect
// ---------------------------------------------------------------------------

interface PlanStatusSelectProps {
  status: PlanStatus;
  disabled?: boolean;
  onChange: (status: PlanStatus) => void;
}

function PlanStatusSelect({ status, disabled, onChange }: PlanStatusSelectProps) {
  const cfg = PLAN_STATUS_CONFIG[status];
  return (
    <SelectPrimitive.Root value={status} onValueChange={(v) => onChange(v as PlanStatus)}>
      <SelectPrimitive.Trigger
        disabled={disabled}
        aria-label="Change plan status"
        className={cn(
          'inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2 py-0.5 border',
          'cursor-pointer outline-none select-none',
          'transition-all duration-150 hover:brightness-125',
          'focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
          'disabled:opacity-40 disabled:cursor-wait',
          cfg.pillBg,
          cfg.pillBorder,
          cfg.textColor,
        )}
      >
        <span
          className={cn('inline-block size-1.5 rounded-full shrink-0', cfg.dotColor, {
            'animate-pulse': cfg.pulse,
          })}
        />
        <SelectPrimitive.Value />
        <ChevronDown className="size-2 opacity-40 shrink-0" />
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          align="start"
          sideOffset={5}
          className="z-50 min-w-[130px] overflow-hidden rounded-lg border border-white/[0.1] bg-[oklch(0.12_0.005_240)] shadow-xl animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <SelectPrimitive.Viewport className="p-1">
            {(Object.entries(PLAN_STATUS_CONFIG) as [PlanStatus, (typeof PLAN_STATUS_CONFIG)[PlanStatus]][]).map(
              ([s, scfg]) => (
                <SelectPrimitive.Item
                  key={s}
                  value={s}
                  className={cn(
                    'relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs cursor-pointer outline-none select-none',
                    'data-[highlighted]:bg-white/[0.07]',
                    scfg.textColor,
                  )}
                >
                  <span
                    className={cn('inline-block size-1.5 rounded-full shrink-0', scfg.dotColor, {
                      'animate-pulse': scfg.pulse,
                    })}
                  />
                  <SelectPrimitive.ItemText>{scfg.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="ml-auto opacity-60 text-[10px]">
                    ✓
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ),
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function PlanMarkdownPreview({ content }: { content: string }) {
  if (!content.trim()) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground/30 italic">Nothing to preview yet.</p>
      </div>
    );
  }

  return (
    <div className="prose prose-invert prose-sm max-w-none px-4 py-4 h-full overflow-y-auto [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-lg font-bold text-foreground/90 border-b border-white/[0.06] pb-2 mb-4 mt-6 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-semibold text-foreground/85 mt-5 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-foreground/80 mt-4 mb-1.5">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-sm text-foreground/70 leading-relaxed mb-3">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside space-y-1 mb-3 text-sm text-foreground/70 pl-2">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside space-y-1 mb-3 text-sm text-foreground/70 pl-2">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="text-sm text-foreground/70">{children}</li>,
          code: ({ className, children, ...rest }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="font-mono text-xs bg-white/[0.07] text-primary/80 rounded px-1.5 py-0.5">
                  {children}
                </code>
              );
            }
            return (
              <code
                className={cn(
                  'block font-mono text-xs bg-[oklch(0.08_0_0)] text-foreground/75 rounded-lg p-3 overflow-x-auto whitespace-pre',
                  className,
                )}
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-3 rounded-lg overflow-hidden border border-white/[0.06]">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary/30 pl-3 my-3 text-sm text-muted-foreground/60 italic">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground/90">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-foreground/70">{children}</em>,
          hr: () => <hr className="border-white/[0.06] my-4" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary/80 hover:text-primary underline underline-offset-2"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlanDetailClient
// ---------------------------------------------------------------------------

interface PlanDetailClientProps {
  plan: Plan;
  project: Project | null;
}

export function PlanDetailClient({ plan: initialPlan, project }: PlanDetailClientProps) {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan>(initialPlan);
  const [viewMode, setViewMode] = useState<ViewMode>('split');

  // Switch to 'edit' on mobile after mount (avoids SSR/client hydration mismatch)
  useEffect(() => {
    if (window.innerWidth < 640) setViewMode('edit');
  }, []);
  const [content, setContent] = useState(initialPlan.content);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  // Status change state
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  // Conversation panel state
  const [conversationOpen, setConversationOpen] = useState(false);
  const [conversationSessionId, setConversationSessionId] = useState<string | null>(
    (initialPlan as Plan & { conversationSessionId?: string | null }).conversationSessionId ?? null,
  );

  // Title editing
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState(initialPlan.title);
  const [title, setTitle] = useState(initialPlan.title);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-save on content change (debounced)
  useEffect(() => {
    if (!isDirty) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      void saveContent(content);
    }, 2000);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [content, isDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveContent = useCallback(
    async (newContent: string) => {
      if (isSaving) return;
      setIsSaving(true);
      setSaveError(null);
      try {
        const result = await apiFetch<ApiResponse<Plan>>(`/api/plans/${plan.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: newContent }),
        });
        setPlan(result.data);
        setIsDirty(false);
        setLastSavedAt(new Date());
      } catch (err: unknown) {
        setSaveError(err instanceof Error ? err.message : 'Save failed');
      } finally {
        setIsSaving(false);
      }
    },
    [plan.id, isSaving],
  );

  const handleContentChange = (value: string) => {
    setContent(value);
    setIsDirty(true);
    setSaveError(null);
  };

  // Called when the agent suggests a plan edit that the user applies
  const handleAgentContentChange = useCallback((newContent: string) => {
    setContent(newContent);
    setIsDirty(true);
    setSaveError(null);
  }, []);

  // Ctrl+S / Cmd+S to save
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        void saveContent(content);
      }
    },
    [content, saveContent],
  );

  const handleContentBlur = () => {
    if (isDirty) {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      void saveContent(content);
    }
  };

  // Title editing
  const startEditingTitle = useCallback(() => {
    setEditTitle(title);
    setIsEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }, [title]);

  const cancelEditingTitle = useCallback(() => {
    setIsEditingTitle(false);
  }, []);

  const saveTitle = useCallback(async () => {
    const trimmed = editTitle.trim();
    setIsEditingTitle(false);
    if (!trimmed || trimmed === title) return;
    const prev = title;
    setTitle(trimmed);
    try {
      const result = await apiFetch<ApiResponse<Plan>>(`/api/plans/${plan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      });
      setPlan(result.data);
    } catch {
      setTitle(prev);
    }
  }, [editTitle, plan.id, title]);

  const handleStatusChange = useCallback(
    (newStatus: PlanStatus) => {
      if (newStatus === plan.status) return;
      if (newStatus === 'archived') {
        setArchiveConfirmOpen(true);
        return;
      }
      void applyStatusChange(newStatus);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan.status],
  );

  const applyStatusChange = useCallback(
    async (newStatus: PlanStatus) => {
      setIsChangingStatus(true);
      try {
        const result = await apiFetch<ApiResponse<Plan>>(`/api/plans/${plan.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        });
        setPlan(result.data);
        if (newStatus === 'archived') {
          router.push('/plans');
        }
      } finally {
        setIsChangingStatus(false);
      }
    },
    [plan.id, router],
  );

  const handleSessionCreated = useCallback((sessionId: string) => {
    setConversationSessionId(sessionId);
  }, []);

  const showEditor = viewMode === 'edit' || viewMode === 'split';
  const showPreview = viewMode === 'preview' || viewMode === 'split';

  return (
    <div className="flex h-full min-h-0 gap-0">
      {/* Main editor area — shrinks when conversation panel opens */}
      <div
        className={cn(
          'flex flex-col h-full min-h-0 gap-4 flex-1 transition-all duration-300 min-w-0',
          conversationOpen && 'lg:max-w-[calc(100%-24rem)]',
        )}
      >
        {/* Header card */}
        <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] shrink-0">
          {/* Status accent top bar */}
          <div
            className="h-[2px] w-full rounded-t-xl"
            style={{ background: STATUS_ACCENT[plan.status] }}
          />

          <div className="px-3 pt-2.5 pb-3 flex flex-col gap-2">
            {/* Row 1: back · title · toolbar */}
            <div className="flex items-center gap-2 min-w-0">
              {/* Back */}
              <Link href="/plans" className="shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground/40 hover:text-foreground/70 hover:bg-white/[0.05]"
                >
                  <ArrowLeft className="size-3.5" />
                </Button>
              </Link>

              {/* Title */}
              <div className="flex-1 min-w-0">
                {isEditingTitle ? (
                  <div className="flex items-center gap-1 min-w-0">
                    <input
                      ref={titleInputRef}
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveTitle();
                        if (e.key === 'Escape') cancelEditingTitle();
                      }}
                      className="flex-1 min-w-0 text-sm font-semibold bg-white/[0.06] border border-white/[0.12] rounded-md px-2.5 py-1 focus:outline-none focus:border-primary/40"
                    />
                    <button
                      onClick={() => void saveTitle()}
                      className="shrink-0 p-1 text-emerald-400 hover:text-emerald-300 transition-colors rounded"
                      aria-label="Save title"
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      onClick={cancelEditingTitle}
                      className="shrink-0 p-1 text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors rounded"
                      aria-label="Cancel"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={startEditingTitle}
                    className="group flex items-center gap-1.5 text-sm font-semibold text-foreground/90 hover:text-foreground transition-colors text-left max-w-full"
                    title="Click to rename"
                  >
                    <span className="truncate">{title}</span>
                    <Pencil className="size-2.5 shrink-0 opacity-0 group-hover:opacity-40 transition-opacity" />
                  </button>
                )}
              </div>

              {/* Toolbar: save · view toggle · actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Save indicator */}
                <div className="text-[10px] hidden sm:flex items-center gap-1 w-12 justify-end">
                  {isSaving && (
                    <>
                      <Loader2 className="size-2.5 animate-spin text-muted-foreground/30" />
                      <span className="text-muted-foreground/30">saving</span>
                    </>
                  )}
                  {!isSaving && isDirty && (
                    <span className="text-amber-400/50">unsaved</span>
                  )}
                  {!isSaving && !isDirty && lastSavedAt && (
                    <span className="text-muted-foreground/25" suppressHydrationWarning>
                      saved
                    </span>
                  )}
                  {saveError && (
                    <span className="text-red-400/60" title={saveError}>
                      error
                    </span>
                  )}
                </div>

                {/* View toggle — icon only, segmented */}
                <div className="flex items-center h-7 rounded-md border border-white/[0.07] bg-white/[0.02] overflow-hidden divide-x divide-white/[0.05]">
                  <button
                    onClick={() => setViewMode('edit')}
                    title="Edit"
                    className={cn(
                      'h-full px-2 flex items-center transition-colors',
                      viewMode === 'edit'
                        ? 'bg-white/[0.08] text-foreground/70'
                        : 'text-muted-foreground/30 hover:text-muted-foreground/60 hover:bg-white/[0.03]',
                    )}
                  >
                    <AlignLeft className="size-3" />
                  </button>
                  <button
                    onClick={() => setViewMode('split')}
                    title="Split"
                    className={cn(
                      'h-full px-2 items-center transition-colors hidden sm:flex',
                      viewMode === 'split'
                        ? 'bg-white/[0.08] text-foreground/70'
                        : 'text-muted-foreground/30 hover:text-muted-foreground/60 hover:bg-white/[0.03]',
                    )}
                  >
                    <Columns2 className="size-3" />
                  </button>
                  <button
                    onClick={() => setViewMode('preview')}
                    title="Preview"
                    className={cn(
                      'h-full px-2 flex items-center transition-colors',
                      viewMode === 'preview'
                        ? 'bg-white/[0.08] text-foreground/70'
                        : 'text-muted-foreground/30 hover:text-muted-foreground/60 hover:bg-white/[0.03]',
                    )}
                  >
                    <Eye className="size-3" />
                  </button>
                </div>

                {/* Action buttons */}
                <PlanActions
                  planId={plan.id}
                  planStatus={plan.status}
                  onToggleConversation={() => setConversationOpen((v) => !v)}
                  conversationActive={conversationOpen}
                />
              </div>
            </div>

            {/* Row 2: status chip · meta breadcrumb */}
            <div className="flex items-center gap-2 pl-9 flex-wrap">
              <PlanStatusSelect
                status={plan.status}
                disabled={isChangingStatus}
                onChange={handleStatusChange}
              />

              <div className="flex items-center gap-2 text-[11px] text-muted-foreground/35 flex-wrap">
                {project && (
                  <span className="flex items-center gap-1">
                    <FolderOpen className="size-3 shrink-0" />
                    {project.name}
                  </span>
                )}
                <span className="flex items-center gap-1" suppressHydrationWarning>
                  <CalendarDays className="size-3 shrink-0" />
                  {formatDistanceToNow(new Date(plan.createdAt), { addSuffix: true })}
                </span>
                {plan.lastValidatedAt && (
                  <span className="flex items-center gap-1" suppressHydrationWarning>
                    <Clock className="size-3 shrink-0" />
                    validated {formatDistanceToNow(new Date(plan.lastValidatedAt), { addSuffix: true })}
                  </span>
                )}
                {plan.executingSessionId && (
                  <Link
                    href={`/sessions/${plan.executingSessionId}`}
                    className="flex items-center gap-0.5 text-violet-400/50 hover:text-violet-400/80 transition-colors"
                  >
                    <ExternalLink className="size-3 shrink-0" />
                    view session
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Editor / Preview split */}
        <div
          className={cn(
            'flex-1 min-h-0 rounded-xl border border-white/[0.06] bg-[oklch(0.08_0_0)] overflow-hidden',
            viewMode === 'split'
              ? 'grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.06]'
              : 'flex flex-col',
          )}
        >
          {/* Editor panel */}
          {showEditor && (
            <div className="flex flex-col min-h-0 h-full">
              {viewMode === 'split' && (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.05] shrink-0">
                  <AlignLeft className="size-3 text-muted-foreground/30" />
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground/30 font-medium">
                    Editor
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground/25">
                    Ctrl+S to save
                  </span>
                </div>
              )}
              <textarea
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleContentBlur}
                spellCheck={false}
                placeholder="Write your plan in markdown..."
                className={cn(
                  'flex-1 w-full bg-transparent px-4 py-4 font-mono text-sm text-foreground/80 placeholder:text-muted-foreground/20',
                  'resize-none focus:outline-none leading-relaxed',
                  'min-h-[300px]',
                )}
              />
            </div>
          )}

          {/* Preview panel */}
          {showPreview && (
            <div className="flex flex-col min-h-0 h-full overflow-hidden">
              {viewMode === 'split' && (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.05] shrink-0">
                  <Eye className="size-3 text-muted-foreground/30" />
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground/30 font-medium">
                    Preview
                  </span>
                </div>
              )}
              <div className="flex-1 overflow-y-auto">
                <PlanMarkdownPreview content={content} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Archive confirmation dialog */}
      <Dialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Archive this plan?</DialogTitle>
            <DialogDescription>
              The plan will be hidden from the default view. You can still find it by selecting
              &ldquo;Archived&rdquo; in the status filter.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setArchiveConfirmOpen(false)}
              disabled={isChangingStatus}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isChangingStatus}
              onClick={() => {
                setArchiveConfirmOpen(false);
                void applyStatusChange('archived');
              }}
              className="gap-1.5"
            >
              {isChangingStatus ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Archive className="size-3" />
              )}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Conversation panel — desktop side panel */}
      {conversationOpen && (
        <>
          <div className="hidden lg:flex w-96 shrink-0 border-l border-amber-500/10 min-h-0 h-full">
            <PlanConversationPanel
              planId={plan.id}
              currentContent={content}
              conversationSessionId={conversationSessionId}
              onContentChange={handleAgentContentChange}
              onClose={() => setConversationOpen(false)}
              onSessionCreated={handleSessionCreated}
            />
          </div>
          {/* Mobile: bottom sheet overlay */}
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setConversationOpen(false)}
            />
            <div className="absolute bottom-0 left-0 right-0 h-[70vh] rounded-t-xl overflow-hidden bg-[oklch(0.085_0.005_240)] border-t border-white/[0.08]">
              <PlanConversationPanel
                planId={plan.id}
                currentContent={content}
                conversationSessionId={conversationSessionId}
                onContentChange={handleAgentContentChange}
                onClose={() => setConversationOpen(false)}
                onSessionCreated={handleSessionCreated}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
