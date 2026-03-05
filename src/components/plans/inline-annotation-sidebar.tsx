'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Check, Loader2, Bot, PenLine, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AnnotationTypeIcon } from '@/components/plans/annotation-type-icon';
import { ANNOTATION_CONFIGS, ANNOTATION_TYPE_ORDER } from '@/lib/utils/annotation-configs';
import { serializeAnnotations } from '@/lib/utils/annotation-serializer';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { PlanAnnotation, AnnotationType, BlockSelection } from '@/lib/types/annotations';
import type { Agent, AgentCapability } from '@/lib/types';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface AgentWithCapabilities extends Agent {
  capabilities: AgentCapability[];
}

interface AgentsApiResponse {
  data: AgentWithCapabilities[];
}

type FormState = {
  type: AnnotationType | null;
  comment: string;
  suggestedText: string;
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface InlineAnnotationSidebarProps {
  planId: string;
  /** null when no active plan chat session. */
  conversationSessionId: string | null;
  /** Current block selection from the preview. */
  selection: BlockSelection | null;
  /** All committed annotations. */
  annotations: PlanAnnotation[];
  onAnnotationAdd: (ann: PlanAnnotation) => void;
  onAnnotationDelete: (id: string) => void;
  /** Called when the sidebar wants to clear the current selection (e.g. after submitting). */
  onClearSelection: () => void;
  /** Called when a new session is created via "Start & Send". Parent updates its state. */
  onSessionCreated: (sessionId: string) => void;
  /** Called when feedback is successfully sent. Parent can open chat panel + close annotation mode. */
  onFeedbackSent: () => void;
  /** Extra className for the root div (used by parent for mobile sheet context). */
  className?: string;
}

// ---------------------------------------------------------------------------
// TypeSelectorGrid sub-component
// ---------------------------------------------------------------------------

function TypeSelectorGrid({ onSelect }: { onSelect: (type: AnnotationType) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {ANNOTATION_TYPE_ORDER.map((type) => {
        const cfg = ANNOTATION_CONFIGS[type];
        return (
          <button
            key={type}
            type="button"
            onClick={() => onSelect(type)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-2 rounded-md text-[11px] font-medium border transition-all hover:opacity-90 active:scale-[0.97] min-h-[44px]',
              cfg.badgeBg,
              cfg.badgeBorder,
              cfg.badgeText,
            )}
          >
            <AnnotationTypeIcon type={type} className="size-3 shrink-0" />
            {cfg.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AnnotationCard sub-component
// ---------------------------------------------------------------------------

function AnnotationCard({
  annotation,
  onDelete,
}: {
  annotation: PlanAnnotation;
  onDelete: () => void;
}) {
  const cfg = ANNOTATION_CONFIGS[annotation.type];
  const locationLabel =
    annotation.lineStart === annotation.lineEnd
      ? `L${annotation.lineStart}`
      : `L${annotation.lineStart}–${annotation.lineEnd}`;

  return (
    <div
      className={cn(
        'rounded-md border border-l-2 p-2 text-[11px] space-y-1.5 group',
        cfg.bg,
        cfg.borderLeft,
      )}
    >
      <div className="flex items-center gap-1.5">
        <AnnotationTypeIcon type={annotation.type} className={cn('size-3 shrink-0', cfg.text)} />
        <span className={cn('text-[9px] font-bold uppercase tracking-widest flex-1', cfg.text)}>
          {cfg.label}
        </span>
        <span className="font-mono text-[9px] text-muted-foreground/30 bg-black/20 px-1 py-0.5 rounded">
          {locationLabel}
        </span>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${cfg.label} annotation`}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-red-400/50 hover:text-red-400 p-0.5 rounded"
        >
          <X className="size-3" />
        </button>
      </div>
      <p className="text-muted-foreground/55 leading-snug line-clamp-3">{annotation.comment}</p>
      {annotation.suggestedText && (
        <p className={cn('text-[10px] font-mono truncate opacity-60', cfg.text)}>
          {'->'} {annotation.suggestedText}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InlineAnnotationSidebar({
  planId,
  conversationSessionId,
  selection,
  annotations,
  onAnnotationAdd,
  onAnnotationDelete,
  onClearSelection,
  onSessionCreated,
  onFeedbackSent,
  className,
}: InlineAnnotationSidebarProps) {
  // Annotation form state
  const [form, setForm] = useState<FormState>({ type: null, comment: '', suggestedText: '' });

  // Agent picker + send state
  const [agents, setAgents] = useState<AgentWithCapabilities[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [globalComment, setGlobalComment] = useState('');

  // Reset form when selection changes to a new set of blocks
  const selectionKey = selection?.blockIds.join(',') ?? '';
  useEffect(() => {
    setForm({ type: null, comment: '', suggestedText: '' });
  }, [selectionKey]);

  // Fetch agents lazily when there is no active session
  useEffect(() => {
    if (conversationSessionId !== null) return;

    let cancelled = false;
    setLoadingAgents(true);
    setAgentError(null);

    void apiFetch<AgentsApiResponse>('/api/agents?capabilities=true&group=ai')
      .then((res) => {
        if (cancelled) return;
        const promptAgents = res.data.filter((a) =>
          a.capabilities?.some((cap) => cap.interactionMode === 'prompt'),
        );
        setAgents(promptAgents);
        setLoadingAgents(false);
        if (promptAgents.length > 0) {
          setSelectedAgentId(promptAgents[0].id);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAgentError(err instanceof Error ? err.message : 'Failed to load agents');
        setLoadingAgents(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationSessionId]);

  // ── Annotation form handlers ─────────────────────────────────────────────

  const handleSelectType = useCallback((type: AnnotationType) => {
    setForm((f) => ({ ...f, type }));
  }, []);

  const handleResetType = useCallback(() => {
    setForm((f) => ({ ...f, type: null }));
  }, []);

  const handleAddAnnotation = useCallback(() => {
    if (!selection || !form.type || !form.comment.trim()) return;
    onAnnotationAdd({
      id: crypto.randomUUID(),
      type: form.type,
      lineStart: selection.lineStart,
      lineEnd: selection.lineEnd,
      selectedText: selection.selectedText,
      comment: form.comment.trim(),
      suggestedText: form.suggestedText.trim() || undefined,
    });
    setForm({ type: null, comment: '', suggestedText: '' });
    onClearSelection();
  }, [selection, form, onAnnotationAdd, onClearSelection]);

  const handleCancelForm = useCallback(() => {
    setForm({ type: null, comment: '', suggestedText: '' });
    onClearSelection();
  }, [onClearSelection]);

  // ── Send handlers ────────────────────────────────────────────────────────

  const canSend = !isSending && (annotations.length > 0 || globalComment.trim().length > 0);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const selectedCapability = selectedAgent?.capabilities.find(
    (cap) => cap.interactionMode === 'prompt',
  );

  const handleSendToChat = useCallback(async () => {
    if (!conversationSessionId || isSending) return;
    setIsSending(true);
    setSendError(null);
    try {
      const feedback = serializeAnnotations(annotations, globalComment);
      await apiFetch(`/api/sessions/${conversationSessionId}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: feedback }),
      });
      onFeedbackSent();
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : 'Failed to send feedback');
    } finally {
      setIsSending(false);
    }
  }, [conversationSessionId, isSending, annotations, globalComment, onFeedbackSent]);

  const handleStartAndSend = useCallback(async () => {
    if (!selectedCapability || isSending) return;
    setIsSending(true);
    setSendError(null);
    try {
      const feedback = serializeAnnotations(annotations, globalComment);
      const result = await apiFetch<ApiResponse<{ sessionId: string }>>(
        `/api/plans/${planId}/conversation`,
        {
          method: 'POST',
          body: JSON.stringify({
            agentId: selectedAgentId,
            capabilityId: selectedCapability.id,
            initialPrompt: feedback,
          }),
        },
      );
      onSessionCreated(result.data.sessionId);
      onFeedbackSent();
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      setIsSending(false);
    }
  }, [
    selectedCapability,
    selectedAgentId,
    planId,
    isSending,
    annotations,
    globalComment,
    onSessionCreated,
    onFeedbackSent,
  ]);

  // ── Derived UI helpers ───────────────────────────────────────────────────

  const locationLabel = selection
    ? selection.lineStart === selection.lineEnd
      ? `Line ${selection.lineStart}`
      : `Lines ${selection.lineStart}–${selection.lineEnd}`
    : null;

  const cfg = form.type ? ANNOTATION_CONFIGS[form.type] : null;
  const canSubmitAnnotation = form.type !== null && form.comment.trim().length > 0;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-[oklch(0.075_0.003_240)] border-l border-white/[0.06]',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] shrink-0">
        <PenLine className="size-3.5 text-violet-400/70 shrink-0" />
        <span className="text-sm font-medium text-foreground/80 flex-1 min-w-0">Annotations</span>
        {annotations.length > 0 && (
          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] bg-violet-500/15 text-violet-400/80 border border-violet-500/20">
            {annotations.length}
          </span>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {/* Selection panel */}
        {selection !== null && (
          <div
            className={cn(
              'rounded-lg border p-3 space-y-2.5',
              cfg
                ? cn(cfg.bg, cfg.borderLeft.replace('border-l-', 'border-'))
                : 'border-violet-500/20 bg-violet-500/[0.05]',
            )}
          >
            {/* Location + type row */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono bg-black/25 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground/50">
                {locationLabel}
              </span>
              {form.type && cfg ? (
                <>
                  <span
                    className={cn(
                      'text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1',
                      cfg.text,
                    )}
                  >
                    <AnnotationTypeIcon type={form.type} className="size-2.5" />
                    {cfg.label}
                  </span>
                  <button
                    type="button"
                    onClick={handleResetType}
                    className="text-[10px] text-muted-foreground/25 hover:text-muted-foreground/55 underline ml-auto"
                  >
                    change
                  </button>
                </>
              ) : (
                <span className="text-[10px] text-muted-foreground/35">selected</span>
              )}
            </div>

            {/* Type selector or comment form */}
            {form.type === null ? (
              <>
                <p className="text-[10px] text-muted-foreground/35">Choose annotation type:</p>
                <TypeSelectorGrid onSelect={handleSelectType} />
                <button
                  type="button"
                  onClick={handleCancelForm}
                  className="text-[10px] text-muted-foreground/25 hover:text-muted-foreground/50 transition-colors"
                >
                  Clear selection
                </button>
              </>
            ) : (
              <>
                <textarea
                  value={form.comment}
                  onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
                  placeholder={cfg?.placeholder ?? ''}
                  rows={3}
                  autoFocus
                  className="w-full text-[11px] bg-black/25 border border-white/[0.07] rounded-md px-2.5 py-2 text-foreground/70 focus:outline-none focus:border-white/[0.15] resize-none placeholder:text-muted-foreground/20 transition-colors"
                />
                {cfg?.hasSuggested && (
                  <textarea
                    value={form.suggestedText}
                    onChange={(e) => setForm((f) => ({ ...f, suggestedText: e.target.value }))}
                    placeholder={cfg.suggestedPlaceholder ?? ''}
                    rows={2}
                    className="w-full text-[11px] font-mono bg-black/25 border border-white/[0.07] rounded-md px-2.5 py-2 text-foreground/60 focus:outline-none focus:border-white/[0.15] resize-none placeholder:text-muted-foreground/20 transition-colors"
                  />
                )}
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    disabled={!canSubmitAnnotation}
                    onClick={handleAddAnnotation}
                    className="flex-1 h-7 gap-1 text-[11px] bg-white/[0.07] hover:bg-white/[0.11] text-foreground/80 border border-white/[0.10] disabled:opacity-35"
                  >
                    <Check className="size-3" />
                    Add
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCancelForm}
                    className="h-7 px-2 text-[11px] text-muted-foreground/40 hover:text-foreground/60"
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Annotation list */}
        {annotations.length > 0 && (
          <div className="space-y-1.5">
            {selection !== null && (
              <p className="text-[9px] text-muted-foreground/25 uppercase tracking-widest px-1 pt-1">
                Existing
              </p>
            )}
            {annotations.map((ann) => (
              <AnnotationCard
                key={ann.id}
                annotation={ann}
                onDelete={() => onAnnotationDelete(ann.id)}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {annotations.length === 0 && selection === null && (
          <div className="py-8 text-center space-y-2">
            <PenLine className="size-6 mx-auto text-violet-500/20" />
            <p className="text-[11px] text-muted-foreground/25 leading-relaxed">
              Click a section in the plan
              <br />
              to annotate it.
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-white/[0.06] p-3 space-y-2">
        <textarea
          value={globalComment}
          onChange={(e) => setGlobalComment(e.target.value)}
          placeholder="Global comment (optional)…"
          rows={2}
          className="w-full text-[11px] bg-black/30 border border-violet-500/15 rounded-md px-2.5 py-2 text-foreground/65 focus:outline-none focus:border-violet-500/30 resize-none placeholder:text-muted-foreground/20 transition-colors"
        />

        {/* Agent picker — only when no active session */}
        {conversationSessionId === null && (
          <div className="space-y-1.5">
            {agentError && (
              <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-1.5">
                {agentError}
              </p>
            )}
            {loadingAgents ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground/50">
                <Loader2 className="size-3 animate-spin" />
                Loading agents…
              </div>
            ) : agents.length === 0 && !agentError ? (
              <p className="text-[11px] text-muted-foreground/40">
                No agents with prompt capabilities found.
              </p>
            ) : agents.length > 0 ? (
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                <SelectTrigger className="w-full border-white/[0.08] bg-white/[0.04] h-8 text-[11px]">
                  <div className="flex items-center gap-2">
                    <Bot className="size-3 text-muted-foreground/50 shrink-0" />
                    <SelectValue placeholder="Select agent" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        )}

        {/* Send error */}
        {sendError && (
          <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-1.5">
            {sendError}
          </p>
        )}

        {/* Send button */}
        {conversationSessionId !== null ? (
          <Button
            size="sm"
            disabled={!canSend}
            onClick={() => void handleSendToChat()}
            className="w-full h-8 gap-1.5 bg-violet-600/80 hover:bg-violet-600 text-white border-0 text-xs disabled:opacity-40"
          >
            {isSending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            Send to Chat
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!canSend || !selectedCapability || loadingAgents}
            onClick={() => void handleStartAndSend()}
            className="w-full h-8 gap-1.5 bg-violet-600/80 hover:bg-violet-600 text-white border-0 text-xs disabled:opacity-40"
          >
            {isSending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            Start &amp; Send
          </Button>
        )}
      </div>
    </div>
  );
}
