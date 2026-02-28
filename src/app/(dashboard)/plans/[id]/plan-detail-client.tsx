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
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { PlanStatusBadge } from '@/components/plans/plan-status-badge';
import { PlanActions } from '@/components/plans/plan-actions';
import { PlanConversationPanel } from '@/components/plans/plan-conversation-panel';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { Plan, Project } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewMode = 'edit' | 'preview' | 'split';

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
  const [content, setContent] = useState(initialPlan.content);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

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

  const handlePlanArchived = useCallback(() => {
    router.push('/plans');
  }, [router]);

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
        <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] shrink-0 overflow-visible">
          {/* Status accent top bar */}
          <div
            className="h-[2px] w-full rounded-t-xl"
            style={{
              background:
                plan.status === 'executing'
                  ? 'linear-gradient(90deg, oklch(0.65 0.2 280 / 0.8) 0%, oklch(0.65 0.2 280 / 0.1) 100%)'
                  : plan.status === 'ready'
                    ? 'linear-gradient(90deg, oklch(0.6 0.2 250 / 0.8) 0%, oklch(0.6 0.2 250 / 0.1) 100%)'
                    : plan.status === 'done'
                      ? 'linear-gradient(90deg, oklch(0.65 0.2 145 / 0.8) 0%, oklch(0.65 0.2 145 / 0.1) 100%)'
                      : 'linear-gradient(90deg, oklch(0.4 0 0 / 0.4) 0%, transparent 100%)',
            }}
          />

          <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
            {/* Back button */}
            <Link href="/plans">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground/50 hover:text-foreground hover:bg-white/[0.05]"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>

            {/* Title + meta */}
            <div className="flex-1 min-w-0">
              {/* Title row */}
              <div className="flex items-center gap-2 flex-wrap">
                {isEditingTitle ? (
                  <div className="flex items-center gap-1">
                    <input
                      ref={titleInputRef}
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveTitle();
                        if (e.key === 'Escape') cancelEditingTitle();
                      }}
                      className="text-base font-semibold bg-white/[0.06] border border-white/[0.15] rounded-lg px-2.5 py-1 focus:outline-none focus:border-primary/50 min-w-0 w-52 sm:w-80"
                    />
                    <button
                      onClick={() => void saveTitle()}
                      className="p-1.5 text-emerald-400 hover:text-emerald-300 transition-colors rounded"
                      aria-label="Save title"
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      onClick={cancelEditingTitle}
                      className="p-1.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors rounded"
                      aria-label="Cancel"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={startEditingTitle}
                    className="group flex items-center gap-1.5 text-base font-semibold hover:text-foreground/80 transition-colors text-left"
                    title="Click to rename plan"
                  >
                    <span className="text-foreground/90">{title}</span>
                    <Pencil className="size-3 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors shrink-0" />
                  </button>
                )}

                <PlanStatusBadge status={plan.status} />
              </div>

              {/* Meta breadcrumb */}
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/40 flex-wrap">
                {project && (
                  <>
                    <span className="flex items-center gap-1">
                      <FolderOpen className="size-3" />
                      {project.name}
                    </span>
                    <span className="text-muted-foreground/20">·</span>
                  </>
                )}
                <span className="flex items-center gap-1" suppressHydrationWarning>
                  <CalendarDays className="size-3" />
                  {formatDistanceToNow(new Date(plan.createdAt), { addSuffix: true })}
                </span>
                {plan.lastValidatedAt && (
                  <>
                    <span className="text-muted-foreground/20">·</span>
                    <span className="flex items-center gap-1" suppressHydrationWarning>
                      <Clock className="size-3" />
                      validated{' '}
                      {formatDistanceToNow(new Date(plan.lastValidatedAt), { addSuffix: true })}
                    </span>
                  </>
                )}
                {plan.executingSessionId && (
                  <>
                    <span className="text-muted-foreground/20">·</span>
                    <Link
                      href={`/sessions/${plan.executingSessionId}`}
                      className="flex items-center gap-0.5 text-violet-400/70 hover:text-violet-400 transition-colors"
                    >
                      <ExternalLink className="size-3" />
                      <span>View session</span>
                    </Link>
                  </>
                )}
              </div>
            </div>

            {/* Right side: save indicator + view toggle + actions */}
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {/* Save status */}
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
                {isSaving && (
                  <>
                    <Loader2 className="size-3 animate-spin text-primary/60" />
                    <span>Saving…</span>
                  </>
                )}
                {!isSaving && isDirty && <span className="text-amber-400/70">Unsaved</span>}
                {!isSaving && !isDirty && lastSavedAt && (
                  <span suppressHydrationWarning>
                    Saved {formatDistanceToNow(lastSavedAt, { addSuffix: true })}
                  </span>
                )}
                {saveError && (
                  <span className="text-red-400/80" title={saveError}>
                    Save error
                  </span>
                )}
              </div>

              {/* View mode toggle */}
              <div className="flex items-center rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5 gap-0.5">
                <button
                  onClick={() => setViewMode('edit')}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-all',
                    viewMode === 'edit'
                      ? 'bg-white/[0.08] text-foreground/80 font-medium'
                      : 'text-muted-foreground/40 hover:text-muted-foreground/70',
                  )}
                  title="Edit only"
                >
                  <AlignLeft className="size-3" />
                  <span className="hidden sm:inline">Edit</span>
                </button>
                <button
                  onClick={() => setViewMode('split')}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-all',
                    viewMode === 'split'
                      ? 'bg-white/[0.08] text-foreground/80 font-medium'
                      : 'text-muted-foreground/40 hover:text-muted-foreground/70',
                  )}
                  title="Split view"
                >
                  <Columns2 className="size-3" />
                  <span className="hidden sm:inline">Split</span>
                </button>
                <button
                  onClick={() => setViewMode('preview')}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-all',
                    viewMode === 'preview'
                      ? 'bg-white/[0.08] text-foreground/80 font-medium'
                      : 'text-muted-foreground/40 hover:text-muted-foreground/70',
                  )}
                  title="Preview only"
                >
                  <Eye className="size-3" />
                  <span className="hidden sm:inline">Preview</span>
                </button>
              </div>

              {/* Plan action buttons */}
              <PlanActions
                planId={plan.id}
                planStatus={plan.status}
                onArchived={handlePlanArchived}
                onToggleConversation={() => setConversationOpen((v) => !v)}
                conversationActive={conversationOpen}
              />
            </div>
          </div>
        </div>

        {/* Editor / Preview split */}
        <div
          className={cn(
            'flex-1 min-h-0 rounded-xl border border-white/[0.06] bg-[oklch(0.08_0_0)] overflow-hidden',
            viewMode === 'split'
              ? 'grid grid-cols-2 divide-x divide-white/[0.06]'
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
