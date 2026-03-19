'use client';

import React, { useState } from 'react';
import { Check, X, Loader2, PenLine, AlignLeft } from 'lucide-react';
import { cn, generateId } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import type { PlanAnnotation, AnnotationType } from '@/lib/types/annotations';
import { serializeAnnotations } from '@/lib/utils/annotation-serializer';
import { ANNOTATION_CONFIGS, ANNOTATION_TYPE_ORDER } from '@/lib/utils/annotation-configs';
import { AnnotationTypeIcon } from '@/components/plans/annotation-type-icon';

// ---------------------------------------------------------------------------
// Line styling
// ---------------------------------------------------------------------------

function getLineTextClass(raw: string): string {
  if (!raw.trim()) return '';
  if (/^#\s/.test(raw)) return 'text-[13px] font-bold text-foreground/90 leading-snug';
  if (/^##\s/.test(raw)) return 'text-[12px] font-semibold text-foreground/80';
  if (/^###\s/.test(raw))
    return 'text-[11px] font-semibold text-foreground/65 uppercase tracking-wider';
  if (/^#{4,}\s/.test(raw)) return 'text-[11px] font-medium text-foreground/60';
  if (/^```/.test(raw)) return 'font-mono text-[11px] text-violet-300/50';
  if (/^\s*([-*+]|\d+\.)\s/.test(raw)) return 'text-[11px] text-foreground/60';
  return 'text-[11px] text-foreground/55';
}

// ---------------------------------------------------------------------------
// Annotation form state
// ---------------------------------------------------------------------------

interface AnnotationFormState {
  lineStart: number; // 1-indexed
  lineEnd: number; // 1-indexed
  selectedText: string;
  type: AnnotationType | null;
  comment: string;
  suggestedText: string;
}

// ---------------------------------------------------------------------------
// Sub-components
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
              'flex items-center gap-1.5 px-2.5 py-2 rounded-md text-[11px] font-medium border transition-all hover:opacity-90 active:scale-[0.97]',
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

interface AnnotationFormPanelProps {
  form: AnnotationFormState;
  onSetType: (type: AnnotationType) => void;
  onSetComment: (v: string) => void;
  onSetSuggested: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function AnnotationFormPanel({
  form,
  onSetType,
  onSetComment,
  onSetSuggested,
  onSubmit,
  onCancel,
}: AnnotationFormPanelProps) {
  const locationLabel =
    form.lineStart === form.lineEnd
      ? `Line ${form.lineStart}`
      : `Lines ${form.lineStart}–${form.lineEnd}`;

  const cfg = form.type ? ANNOTATION_CONFIGS[form.type] : null;
  const canSubmit = form.type !== null && form.comment.trim().length > 0;

  return (
    <div
      className={cn(
        'rounded-lg border p-3 space-y-2.5',
        cfg
          ? cn(cfg.bg, cfg.borderLeft.replace('border-l-', 'border-'))
          : 'border-violet-500/20 bg-violet-500/[0.05]',
      )}
    >
      {/* Location label */}
      <div className="flex items-center gap-1.5">
        <span className="font-mono bg-black/25 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground/50">
          {locationLabel}
        </span>
        {form.type && cfg && (
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
              onClick={() => onSetType(null as unknown as AnnotationType)}
              className="text-[10px] text-muted-foreground/25 hover:text-muted-foreground/55 underline ml-auto"
            >
              change
            </button>
          </>
        )}
      </div>

      {/* Type selector or form */}
      {!form.type ? (
        <>
          <p className="text-[10px] text-muted-foreground/35">Choose annotation type:</p>
          <TypeSelectorGrid onSelect={onSetType} />
        </>
      ) : (
        <>
          <textarea
            value={form.comment}
            onChange={(e) => onSetComment(e.target.value)}
            placeholder={cfg?.placeholder ?? ''}
            rows={3}
            autoFocus
            className="w-full text-[11px] bg-black/25 border border-white/[0.07] rounded-md px-2.5 py-2 text-foreground/70 focus:outline-none focus:border-white/[0.15] resize-none placeholder:text-muted-foreground/20 transition-colors"
          />
          {cfg?.hasSuggested && (
            <textarea
              value={form.suggestedText}
              onChange={(e) => onSetSuggested(e.target.value)}
              placeholder={cfg.suggestedPlaceholder ?? ''}
              rows={2}
              className="w-full text-[11px] font-mono bg-black/25 border border-white/[0.07] rounded-md px-2.5 py-2 text-foreground/60 focus:outline-none focus:border-white/[0.15] resize-none placeholder:text-muted-foreground/20 transition-colors"
            />
          )}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={onSubmit}
              className="flex-1 h-7 gap-1 text-[11px] bg-white/[0.07] hover:bg-white/[0.11] text-foreground/80 border border-white/[0.10] disabled:opacity-35"
            >
              <Check className="size-3" />
              Add
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              className="h-7 px-2 text-[11px] text-muted-foreground/40 hover:text-foreground/60"
            >
              <X className="size-3" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

interface AnnotationCardProps {
  annotation: PlanAnnotation;
  onDelete: () => void;
}

function AnnotationCard({ annotation, onDelete }: AnnotationCardProps) {
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
          className="opacity-0 group-hover:opacity-100 transition-opacity text-red-400/50 hover:text-red-400 p-0.5 rounded"
        >
          <X className="size-3" />
        </button>
      </div>
      <p className="text-muted-foreground/55 leading-snug line-clamp-3">{annotation.comment}</p>
      {annotation.suggestedText && (
        <p className={cn('text-[10px] font-mono truncate opacity-60', cfg.text)}>
          → {annotation.suggestedText}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main PlanAnnotator component
// ---------------------------------------------------------------------------

export interface PlanAnnotatorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The raw markdown plan content. Null = plan unavailable (show fallback). */
  planContent: string | null;
  /** Called with the serialized feedback string when the user sends. */
  onSend: (feedback: string) => void;
  isSending: boolean;
}

export function PlanAnnotator({
  open,
  onOpenChange,
  planContent,
  onSend,
  isSending,
}: PlanAnnotatorProps) {
  const lines = planContent ? planContent.split('\n') : [];

  // Selection state (0-indexed internally)
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  // Annotation form (open when selection is confirmed)
  const [form, setForm] = useState<AnnotationFormState | null>(null);
  // All committed annotations
  const [annotations, setAnnotations] = useState<PlanAnnotation[]>([]);
  // Global comment textarea
  const [globalComment, setGlobalComment] = useState('');

  // Derived selection bounds
  const hasActiveSelection = selStart !== null && selEnd !== null && form === null;
  const selMin =
    hasActiveSelection && selStart !== null && selEnd !== null ? Math.min(selStart, selEnd) : null;
  const selMax =
    hasActiveSelection && selStart !== null && selEnd !== null ? Math.max(selStart, selEnd) : null;

  // Map line index (0-based) → annotations covering it
  const lineAnnotationMap = new Map<number, PlanAnnotation[]>();
  for (const ann of annotations) {
    for (let i = ann.lineStart - 1; i <= ann.lineEnd - 1; i++) {
      if (!lineAnnotationMap.has(i)) lineAnnotationMap.set(i, []);
      lineAnnotationMap.get(i)?.push(ann);
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  function handleLineClick(idx: number, shiftKey: boolean) {
    if (form) return; // Lock selection while form is open
    if (shiftKey && selStart !== null) {
      setSelEnd(idx);
    } else {
      setSelStart(idx);
      setSelEnd(idx);
    }
  }

  function openAnnotationForm() {
    if (selMin === null || selMax === null) return;
    setForm({
      lineStart: selMin + 1,
      lineEnd: selMax + 1,
      selectedText: lines.slice(selMin, selMax + 1).join('\n'),
      type: null,
      comment: '',
      suggestedText: '',
    });
  }

  function cancelForm() {
    setForm(null);
    setSelStart(null);
    setSelEnd(null);
  }

  function submitAnnotation() {
    if (!form || !form.type || !form.comment.trim()) return;
    const type = form.type;
    setAnnotations((prev) => [
      ...prev,
      {
        id: generateId(),
        type,
        lineStart: form.lineStart,
        lineEnd: form.lineEnd,
        selectedText: form.selectedText,
        comment: form.comment.trim(),
        suggestedText: form.suggestedText.trim() || undefined,
      },
    ]);
    setForm(null);
    setSelStart(null);
    setSelEnd(null);
  }

  function handleSend() {
    const feedback = serializeAnnotations(annotations, globalComment);
    onSend(feedback);
    // Reset internal state for next use
    setAnnotations([]);
    setGlobalComment('');
    setForm(null);
    setSelStart(null);
    setSelEnd(null);
  }

  const canSend = !isSending && (annotations.length > 0 || globalComment.trim().length > 0);

  // ── Sidebar content ───────────────────────────────────────────────────────

  const selectionLabel =
    hasActiveSelection && selMin !== null && selMax !== null
      ? selMin === selMax
        ? `Line ${selMin + 1}`
        : `Lines ${selMin + 1}–${selMax + 1}`
      : null;

  const formInRange = form !== null ? { start: form.lineStart - 1, end: form.lineEnd - 1 } : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-4xl bg-[oklch(0.065_0.01_280)] border-l border-violet-500/20 p-0 flex flex-col gap-0"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-violet-500/[0.12] shrink-0">
          <div className="p-1.5 rounded-lg bg-violet-500/[0.12] border border-violet-500/[0.20] shrink-0">
            <PenLine className="size-3.5 text-violet-400" />
          </div>
          <SheetTitle className="text-sm font-semibold text-foreground/85 flex-1 min-w-0">
            Annotate Plan
          </SheetTitle>
          {annotations.length > 0 && (
            <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] bg-violet-500/15 text-violet-400/80 border border-violet-500/20">
              {annotations.length} annotation{annotations.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* ── Body: split pane ───────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* ── Left: Plan lines ───────────────────────────────────────── */}
          <div className="flex-1 min-w-0 overflow-y-auto border-r border-violet-500/[0.08] flex flex-col">
            {!planContent ? (
              <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8 text-center">
                <AlignLeft className="size-8 text-violet-500/20" />
                <p className="text-[11px] text-muted-foreground/30 leading-relaxed">
                  Plan content unavailable.
                  <br />
                  Use the global comment to send feedback.
                </p>
              </div>
            ) : (
              <>
                {/* Instruction bar */}
                <div className="sticky top-0 z-10 px-3 py-1.5 text-[9px] text-muted-foreground/25 bg-[oklch(0.065_0.01_280)] border-b border-white/[0.04] uppercase tracking-widest shrink-0 select-none">
                  Click line to select · Shift+click to extend range
                </div>
                {/* Lines */}
                <div className="pb-12">
                  {lines.map((line, idx) => {
                    const isBlank = !line.trim();
                    const isSelected =
                      hasActiveSelection &&
                      selMin !== null &&
                      selMax !== null &&
                      idx >= selMin &&
                      idx <= selMax;
                    const isInForm =
                      formInRange !== null && idx >= formInRange.start && idx <= formInRange.end;
                    const lineAnns = lineAnnotationMap.get(idx) ?? [];
                    const isAnnotated = lineAnns.length > 0;
                    const firstAnnCfg = isAnnotated ? ANNOTATION_CONFIGS[lineAnns[0].type] : null;

                    return (
                      <div
                        key={idx}
                        onClick={(e) => handleLineClick(idx, e.shiftKey)}
                        className={cn(
                          'flex items-start border-l-2 cursor-pointer transition-colors duration-75',
                          isBlank ? 'h-[14px]' : 'min-h-[22px]',
                          isSelected
                            ? 'bg-violet-500/[0.10] border-l-violet-500/60'
                            : isInForm
                              ? 'bg-violet-500/[0.07] border-l-violet-400/35'
                              : isAnnotated && firstAnnCfg
                                ? cn(firstAnnCfg.bg, firstAnnCfg.borderLeft)
                                : 'border-l-transparent hover:bg-white/[0.02] hover:border-l-white/[0.08]',
                        )}
                      >
                        {/* Line number */}
                        <span
                          className={cn(
                            'shrink-0 w-8 text-right pr-2 text-[10px] font-mono leading-[22px] select-none tabular-nums',
                            isSelected ? 'text-violet-400/60' : 'text-white/15',
                          )}
                        >
                          {idx + 1}
                        </span>
                        {/* Annotation dot indicator */}
                        <span className="shrink-0 w-3 flex items-center justify-center leading-[22px]">
                          {isAnnotated && firstAnnCfg && (
                            <span
                              className={cn('size-1.5 rounded-full inline-block', firstAnnCfg.dot)}
                            />
                          )}
                        </span>
                        {/* Line text */}
                        {!isBlank && (
                          <span
                            className={cn(
                              'flex-1 py-[3px] pl-0.5 pr-4 font-mono whitespace-pre-wrap break-words leading-[1.45]',
                              getLineTextClass(line),
                            )}
                          >
                            {line}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* ── Right: Annotation sidebar ──────────────────────────────── */}
          <div className="w-64 sm:w-72 shrink-0 flex flex-col min-h-0 bg-[oklch(0.06_0.009_280)]">
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
              {/* Active selection → annotate prompt */}
              {hasActiveSelection && !form && (
                <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.05] p-3 space-y-2.5">
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="font-mono bg-violet-500/15 px-1.5 py-0.5 rounded text-[10px] text-violet-400/70">
                      {selectionLabel}
                    </span>
                    <span className="text-muted-foreground/35">selected</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {ANNOTATION_TYPE_ORDER.map((type) => {
                      const cfg = ANNOTATION_CONFIGS[type];
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => {
                            openAnnotationForm();
                            // Pre-select type after form opens via a small delay
                            // so the form state is set before we update type.
                            setTimeout(() => {
                              setForm((f) => (f ? { ...f, type } : f));
                            }, 0);
                          }}
                          className={cn(
                            'flex items-center gap-1.5 px-2.5 py-2 rounded-md text-[11px] font-medium border transition-all hover:opacity-90 active:scale-[0.97]',
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
                  <button
                    type="button"
                    onClick={cancelForm}
                    className="text-[10px] text-muted-foreground/25 hover:text-muted-foreground/50 transition-colors"
                  >
                    Clear selection
                  </button>
                </div>
              )}

              {/* Annotation form (type chosen) */}
              {form && (
                <AnnotationFormPanel
                  form={form}
                  onSetType={(type) => {
                    if (!type) {
                      setForm((f) => (f ? { ...f, type: null } : f));
                    } else {
                      setForm((f) => (f ? { ...f, type } : f));
                    }
                  }}
                  onSetComment={(comment) => setForm((f) => (f ? { ...f, comment } : f))}
                  onSetSuggested={(suggestedText) =>
                    setForm((f) => (f ? { ...f, suggestedText } : f))
                  }
                  onSubmit={submitAnnotation}
                  onCancel={cancelForm}
                />
              )}

              {/* Committed annotations list */}
              {annotations.length > 0 && (
                <div className="space-y-1.5">
                  {(hasActiveSelection || form) && (
                    <p className="text-[9px] text-muted-foreground/25 uppercase tracking-widest px-1 pt-1">
                      Existing
                    </p>
                  )}
                  {annotations.map((ann) => (
                    <AnnotationCard
                      key={ann.id}
                      annotation={ann}
                      onDelete={() => setAnnotations((prev) => prev.filter((a) => a.id !== ann.id))}
                    />
                  ))}
                </div>
              )}

              {/* Empty state */}
              {annotations.length === 0 && !hasActiveSelection && !form && (
                <div className="py-8 text-center space-y-2">
                  <PenLine className="size-6 mx-auto text-violet-500/20" />
                  <p className="text-[11px] text-muted-foreground/25 leading-relaxed">
                    Select lines in the plan
                    <br />
                    to add annotations.
                  </p>
                </div>
              )}
            </div>

            {/* ── Footer: global comment + send ──────────────────────── */}
            <div className="shrink-0 border-t border-violet-500/[0.10] p-3 space-y-2">
              <textarea
                value={globalComment}
                onChange={(e) => setGlobalComment(e.target.value)}
                placeholder="Global comment (optional)…"
                rows={2}
                className="w-full text-[11px] bg-black/30 border border-violet-500/15 rounded-md px-2.5 py-2 text-foreground/65 focus:outline-none focus:border-violet-500/30 resize-none placeholder:text-muted-foreground/20 transition-colors"
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  disabled={!canSend}
                  onClick={handleSend}
                  className="flex-1 h-8 gap-1.5 bg-violet-600/80 hover:bg-violet-600 text-white border-0 text-xs disabled:opacity-40"
                >
                  {isSending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  Send Feedback
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  className="h-8 px-3 text-xs text-muted-foreground/45 hover:text-foreground/65 border border-white/[0.06] hover:border-white/[0.12]"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
