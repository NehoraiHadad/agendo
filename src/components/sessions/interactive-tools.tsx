'use client';

/**
 * Interactive tool renderer registry.
 *
 * Any tool that requires a human response (approval, question, confirmation…)
 * registers a single React component here.  Both ToolCard (tool-result path)
 * and ToolApprovalCard (approval path) look up the registry and delegate
 * rendering — no separate component file needed for each new tool.
 *
 * Adding a new interactive tool:
 *   1. Write a renderer component (InteractiveToolProps → React.ReactNode)
 *   2. Add it to TOOL_RENDERERS at the bottom of this file
 *   Done — ToolCard and ToolApprovalCard pick it up automatically.
 */

import React, { useState, useEffect } from 'react';
import {
  Check,
  Loader2,
  BookOpen,
  CheckCircle2,
  Terminal,
  MessageSquare,
  Play,
  RotateCcw,
  Layers,
  Maximize2,
  X,
  Pencil,
  ChevronRight,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * What the renderer sends back to the host card when the user responds.
 * The host card (ToolCard or ToolApprovalCard) translates this into the
 * appropriate API call — the renderer never talks to the network directly.
 */
export type ToolResponsePayload =
  | { kind: 'tool-result'; content: string }
  | {
      kind: 'approval';
      decision: 'allow' | 'deny' | 'allow-session';
      updatedInput?: Record<string, unknown>;
      /** ExitPlanMode: switch permission mode before allowing (avoids race). */
      postApprovalMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
      /** ExitPlanMode: compact conversation after allowing. */
      postApprovalCompact?: boolean;
      /** ExitPlanMode option 1: deny tool, kill process, restart fresh with plan as context. */
      clearContextRestart?: boolean;
    };

export interface InteractiveToolProps {
  /** Session ID — needed by some renderers (e.g. ExitPlanMode) for side-effect API calls. */
  sessionId: string;
  /** Current session status — renderers use this to detect stale cards (idle/ended). */
  sessionStatus?: string | null;
  /** The tool_use input sent by the model. */
  input: Record<string, unknown>;
  /** True once any response has been received/submitted (disables the UI). */
  isAnswered: boolean;
  /** Called by the renderer when the user submits a response. */
  respond: (payload: ToolResponsePayload) => Promise<void>;
  /** Optional callback for the host card to hide/cleanup after resolution. */
  onResolved?: () => void;
}

export type InteractiveToolRenderer = React.FC<InteractiveToolProps>;

// ---------------------------------------------------------------------------
// AskUserQuestion renderer
// ---------------------------------------------------------------------------

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

function AskUserQuestionRenderer({ input, isAnswered, respond, onResolved }: InteractiveToolProps) {
  const questions = Array.isArray(input.questions) ? (input.questions as Question[]) : [];

  // Per-step committed answers (finalized when user advances past a step)
  const [committedAnswers, setCommittedAnswers] = useState<Record<number, Set<string>>>({});
  // Working selections for the active step
  const [currentSelections, setCurrentSelections] = useState<Set<string>>(new Set());
  const [currentStep, setCurrentStep] = useState(0);
  // Incrementing this key on the question panel triggers re-animation via CSS
  const [stepKey, setStepKey] = useState(0);

  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while the 220ms transition delay is in progress (blocks new input)
  const [isTransitioning, setIsTransitioning] = useState(false);

  const isDone = submitted || isAnswered;
  const isSingleQ = questions.length === 1;
  const currentQ = questions[currentStep] as Question | undefined;
  const isLastStep = currentStep === questions.length - 1;
  const isMultiSelectStep = currentQ?.multiSelect ?? false;

  // ── Done state ─────────────────────────────────────────────────────────────
  if (isDone) {
    // Only show per-question answers when WE submitted (local state has them)
    const finalAnswers: Record<number, Set<string>> = submitted
      ? { ...committedAnswers, [currentStep]: currentSelections }
      : {};
    return (
      <div className="rounded-xl border border-primary/15 bg-primary/[0.04] px-3.5 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-3.5 text-primary/60 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-primary/50">
            {isSingleQ ? 'Answered' : `${questions.length} responses sent`}
          </span>
        </div>
        {submitted && questions.length > 0 && (
          <div className="space-y-1 pt-0.5">
            {questions.map((q, i) => {
              const selected = [...(finalAnswers[i] ?? [])];
              if (!selected.length) return null;
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="text-foreground/35 flex-1 min-w-0 truncate">
                    {q.header ?? q.question}
                  </span>
                  <span className="shrink-0 bg-primary/[0.12] text-primary/65 px-2 py-0.5 rounded-full text-[11px] font-medium max-w-[160px] truncate">
                    {selected.join(', ')}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (!currentQ) return null;

  const canSubmit = currentSelections.size > 0 && !loading && !isTransitioning;
  const canNext = currentSelections.size > 0 && !isTransitioning;

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleToggle(optLabel: string) {
    if (isDone || isTransitioning) return;

    if (isMultiSelectStep) {
      setCurrentSelections((prev) => {
        const next = new Set(prev);
        if (next.has(optLabel)) next.delete(optLabel);
        else next.add(optLabel);
        return next;
      });
    } else {
      // Single-select: set immediately for visual feedback, then auto-advance
      const newSel = new Set([optLabel]);
      setCurrentSelections(newSel);

      if (!isLastStep) {
        // Capture values from closure (fresh at click time)
        const nextIdx = currentStep + 1;
        const nextPrevSel = committedAnswers[nextIdx];
        setIsTransitioning(true);
        setTimeout(() => {
          setCommittedAnswers((prev) => ({ ...prev, [currentStep]: newSel }));
          setCurrentStep(nextIdx);
          setCurrentSelections(new Set(nextPrevSel));
          setStepKey((k) => k + 1);
          setIsTransitioning(false);
        }, 220);
      }
      // Last step + single-select: keep selection, wait for submit button
    }
  }

  function handleNext() {
    if (!canNext || isLastStep) return;
    const nextIdx = currentStep + 1;
    const nextPrevSel = committedAnswers[nextIdx];
    setIsTransitioning(true);
    setTimeout(() => {
      setCommittedAnswers((prev) => ({ ...prev, [currentStep]: currentSelections }));
      setCurrentStep(nextIdx);
      setCurrentSelections(new Set(nextPrevSel));
      setStepKey((k) => k + 1);
      setIsTransitioning(false);
    }, 220);
  }

  function handleBack(targetStep: number) {
    // Preserve the current step's selections before stepping back
    setCommittedAnswers((prev) => ({ ...prev, [currentStep]: currentSelections }));
    setCurrentStep(targetStep);
    setCurrentSelections(new Set(committedAnswers[targetStep]));
    setStepKey((k) => k + 1);
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    const finalCommitted = { ...committedAnswers, [currentStep]: currentSelections };
    const allAnswered = questions.every((_, i) => (finalCommitted[i]?.size ?? 0) > 0);
    if (!allAnswered) return;

    setLoading(true);
    setError(null);

    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const selected = [...(finalCommitted[i] ?? [])];
      answers[q.question] = q.multiSelect ? selected.join(', ') : (selected[0] ?? '');
    }

    try {
      await respond({ kind: 'approval', decision: 'allow', updatedInput: { answers } });
      setSubmitted(true);
      onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  // ── Wizard card ────────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-primary/25 bg-[oklch(0.085_0.012_280)] overflow-hidden text-sm">
      {/* Accent bar */}
      <div className="h-[2px] bg-gradient-to-r from-primary/70 via-primary/20 to-transparent" />

      {/* Header */}
      <div className="px-3.5 pt-3 pb-2.5 flex items-center gap-2 border-b border-white/[0.05]">
        <span className="size-1.5 rounded-full bg-primary animate-pulse shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-primary/55 flex-1">
          {isSingleQ ? 'Awaiting your input' : 'Agent has questions'}
        </span>
        {/* Step progress — multi-question only */}
        {!isSingleQ && (
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
            <span className="tabular-nums">
              {currentStep + 1}&thinsp;/&thinsp;{questions.length}
            </span>
            <span className="flex gap-[3px]">
              {questions.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-[3px] rounded-full transition-all duration-300',
                    i < currentStep
                      ? 'w-3 bg-primary/45'
                      : i === currentStep
                        ? 'w-4 bg-primary'
                        : 'w-2 bg-white/15',
                  )}
                />
              ))}
            </span>
          </span>
        )}
      </div>

      {/* Answered echoes — clickable rows to step back */}
      {!isSingleQ && currentStep > 0 && (
        <div className="border-b border-white/[0.05]">
          {Array.from({ length: currentStep }, (_, i) => {
            const q = questions[i];
            const selected = [...(committedAnswers[i] ?? [])];
            if (!selected.length) return null;
            return (
              <button
                key={i}
                type="button"
                disabled={isTransitioning}
                onClick={() => handleBack(i)}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs hover:bg-white/[0.03] transition-colors group disabled:pointer-events-none"
              >
                <CheckCircle2 className="size-3 text-primary/40 shrink-0" />
                <span className="text-foreground/35 flex-1 text-left truncate min-w-0">
                  {q.header ?? q.question}
                </span>
                <span className="bg-primary/[0.10] text-primary/55 px-2 py-[2px] rounded text-[11px] shrink-0 max-w-[120px] truncate">
                  {selected.join(', ')}
                </span>
                <Pencil className="size-2.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      {/* Current question — key on stepKey triggers re-animation */}
      <div key={stepKey} className="px-3.5 pt-4 pb-4 space-y-3 animate-fade-in-up">
        {/* Question text */}
        <div className="space-y-0.5">
          {currentQ.header && (
            <p className="text-[10px] uppercase tracking-widest text-primary/40 font-semibold">
              {currentQ.header}
            </p>
          )}
          <p className="font-medium text-foreground/90 leading-relaxed">{currentQ.question}</p>
          {isMultiSelectStep && (
            <p className="text-[11px] text-muted-foreground/40 pt-0.5">Select all that apply</p>
          )}
        </div>

        {/* Options */}
        <div className="space-y-1.5">
          {currentQ.options.map((opt) => {
            const isSelected = currentSelections.has(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                disabled={isTransitioning}
                onClick={() => handleToggle(opt.label)}
                className={cn(
                  'w-full text-left rounded-xl border px-3 py-2.5 transition-all duration-150',
                  'flex items-start gap-2.5',
                  isSelected
                    ? 'border-primary/45 bg-primary/[0.09] shadow-[0_0_12px_oklch(0.7_0.18_280/0.08)]'
                    : 'border-white/[0.06] bg-white/[0.02] hover:border-primary/20 hover:bg-primary/[0.04]',
                  isTransitioning && 'pointer-events-none',
                )}
              >
                {/* Radio/checkbox indicator */}
                <span
                  className={cn(
                    'mt-[3px] shrink-0 h-3.5 w-3.5 border-2 transition-all duration-150 flex items-center justify-center',
                    isMultiSelectStep ? 'rounded-sm' : 'rounded-full',
                    isSelected ? 'border-primary bg-primary' : 'border-white/20',
                  )}
                >
                  {isSelected && (
                    <span
                      className={cn(
                        'bg-white block',
                        isMultiSelectStep
                          ? 'h-1.5 w-1.5 rounded-[1px]'
                          : 'h-1.5 w-1.5 rounded-full',
                      )}
                    />
                  )}
                </span>

                {/* Label + description */}
                <div className="min-w-0 flex-1">
                  <span
                    className={cn('text-sm', isSelected ? 'text-foreground' : 'text-foreground/70')}
                  >
                    {opt.label}
                  </span>
                  {opt.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground/45 leading-relaxed">
                      {opt.description}
                    </p>
                  )}
                </div>

                {/* Arrow hint for single-select non-last step */}
                {isSelected && !isMultiSelectStep && !isLastStep && (
                  <ChevronRight className="shrink-0 size-3.5 text-primary/40 mt-[3px]" />
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-800/30 rounded px-2 py-1">
            {error}
          </p>
        )}

        {/* Navigation footer */}
        <div className="flex items-center gap-2 pt-0.5">
          {/* Back button — shown in multi-Q when not on first step */}
          {!isSingleQ && currentStep > 0 && !isTransitioning && (
            <button
              type="button"
              onClick={() => handleBack(currentStep - 1)}
              className="text-xs text-muted-foreground/35 hover:text-muted-foreground/60 transition-colors"
            >
              ← Back
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* Next button — multi-select non-last steps */}
            {!isLastStep && isMultiSelectStep && (
              <button
                type="button"
                disabled={!canNext}
                onClick={handleNext}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150',
                  canNext
                    ? 'border-primary/30 bg-primary/[0.08] text-primary/80 hover:bg-primary/[0.16] hover:border-primary/45 active:scale-[0.98]'
                    : 'border-white/[0.05] bg-transparent text-muted-foreground/30 cursor-not-allowed',
                )}
              >
                Next
                <ChevronRight className="size-3.5" />
              </button>
            )}

            {/* Submit button — last step (or single question) */}
            {isLastStep && (
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150',
                  canSubmit
                    ? 'border-primary/40 bg-primary/[0.12] text-primary hover:bg-primary/[0.22] hover:border-primary/55 active:scale-[0.98]'
                    : 'border-white/[0.05] bg-white/[0.02] text-muted-foreground/30 cursor-not-allowed',
                )}
              >
                {loading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {isSingleQ ? 'Submit' : 'Submit answers'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExitPlanMode — markdown components (module-level to avoid re-creating each render)
// ---------------------------------------------------------------------------

const planMdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ children }) => (
    <h1 className="text-[13px] font-bold text-foreground/90 mb-2 mt-3 first:mt-0 leading-snug">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xs font-bold text-foreground/80 mb-1.5 mt-2.5 uppercase tracking-wide">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-xs font-semibold text-foreground/75 mb-1 mt-2">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="mb-1.5 last:mb-0 leading-relaxed text-foreground/65 text-xs">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="list-disc list-inside space-y-0.5 mb-1.5 text-foreground/65 text-xs">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside space-y-0.5 mb-1.5 text-foreground/65 text-xs">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ children, className }) => {
    const isBlock = className?.startsWith('language-');
    return isBlock ? (
      <pre className="bg-black/40 rounded-lg p-2 text-[11px] font-mono overflow-auto max-h-28 text-violet-300/70 my-1.5 whitespace-pre-wrap border border-violet-500/10">
        <code>{children}</code>
      </pre>
    ) : (
      <code className="bg-violet-500/10 text-violet-300/80 rounded px-1 text-[11px] font-mono">
        {children}
      </code>
    );
  },
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground/85">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-foreground/70">{children}</em>,
  hr: () => <hr className="border-white/[0.06] my-2" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-violet-500/40 pl-3 text-muted-foreground/55 italic my-1.5 text-xs">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-violet-400/80 underline hover:text-violet-300"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
};

// ---------------------------------------------------------------------------
// ExitPlanMode renderer
// ---------------------------------------------------------------------------

interface AllowedPrompt {
  tool?: string;
  prompt?: string;
}

type PostApprovalMode = 'bypassPermissions' | 'acceptEdits' | 'default';
type PlanAction = 'approve' | 'compact' | 'restart' | 'revise';

const MODE_OPTIONS: { value: PostApprovalMode; label: string; title: string }[] = [
  {
    value: 'bypassPermissions',
    label: 'Auto',
    title: 'All tools auto-approved — fully autonomous execution',
  },
  {
    value: 'acceptEdits',
    label: 'Edit-only',
    title: 'File edits auto-approved, bash commands need approval',
  },
  { value: 'default', label: 'Manual', title: 'Every tool requires your explicit approval' },
];

function ExitPlanModeRenderer({
  sessionId,
  sessionStatus,
  input,
  isAnswered,
  respond,
  onResolved,
}: InteractiveToolProps) {
  const [pending, setPending] = useState<PlanAction | null>(null);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planSheetOpen, setPlanSheetOpen] = useState(false);
  const [approvalMode, setApprovalMode] = useState<PostApprovalMode>('acceptEdits');
  const isSessionLive = sessionStatus === 'active' || sessionStatus === 'awaiting_input';
  const isSessionIdle = !isSessionLive;
  const isDisabled = isAnswered || pending !== null;

  const allowedPrompts = Array.isArray(input.allowedPrompts)
    ? (input.allowedPrompts as AllowedPrompt[])
    : [];

  // Fetch plan content from the session's stored plan file
  useEffect(() => {
    fetch(`/api/sessions/${sessionId}/plan`)
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { content?: string | null } }>) : null))
      .then((data) => {
        setPlanContent(data?.data?.content ?? null);
        setPlanLoading(false);
      })
      .catch(() => setPlanLoading(false));
  }, [sessionId]);

  async function handleApprove(action: 'approve' | 'compact' | 'restart') {
    setError(null);
    setPending(action);
    try {
      if (action === 'restart') {
        // Clear context + restart fresh: deny tool, kill/reset process, re-spawn
        // with the plan as the new initialPrompt (context cleared).
        await respond({
          kind: 'approval',
          decision: 'deny',
          clearContextRestart: true,
          postApprovalMode: approvalMode,
        });
      } else {
        // Allow in-place (approve / approve+compact). Works for both live and idle
        // sessions. For idle sessions, the control route updates permissionMode +
        // initialPrompt (plan content) and re-enqueues with the existing sessionRef
        // so Claude resumes the same conversation. The CLI strips the unresolved
        // ExitPlanMode tool_use on resume, so Claude simply continues implementing.
        await respond({
          kind: 'approval',
          decision: 'allow',
          postApprovalMode: approvalMode,
          postApprovalCompact: action === 'compact',
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      setPending(null);
    }
  }

  async function handleFeedback() {
    if (!feedbackText.trim()) return;
    setError(null);
    setPending('revise');
    try {
      // For live sessions, deny the ExitPlanMode approval first so the agent
      // returns to plan mode and receives the feedback.
      if (isSessionLive) {
        await respond({ kind: 'approval', decision: 'deny' });
      }
      // Send the feedback as a follow-up message. For idle sessions this also
      // cold-resumes the session (the /message route handles that).
      await fetch(`/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: feedbackText.trim() }),
      });
      onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      setPending(null);
    }
  }

  // Compact "answered" state shown after the user has acted
  if (isAnswered && !feedbackMode) {
    return (
      <div className="rounded-md border border-violet-500/15 bg-violet-500/[0.03] px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground/60">
        <CheckCircle2 className="size-3.5 text-violet-400/60 shrink-0" />
        <span>Plan approved — implementing</span>
      </div>
    );
  }

  const hasPlanContent = !planLoading && planContent !== null;
  const hasAllowedPrompts = allowedPrompts.length > 0;

  return (
    <div className="rounded-xl border border-violet-500/25 bg-[oklch(0.085_0.015_280)] overflow-hidden text-sm">
      {/* Violet accent bar at top */}
      <div className="h-[2px] bg-gradient-to-r from-violet-500/80 via-violet-400/30 to-transparent" />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="px-3.5 pt-3 pb-2.5 flex items-center gap-2.5 border-b border-violet-500/[0.12]">
        <div className="p-1.5 rounded-lg bg-violet-500/[0.12] border border-violet-500/[0.18] shrink-0">
          <BookOpen className="size-3.5 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground/90 text-[13px] leading-tight">
            Plan ready for review
          </p>
          <p className="text-[10px] text-violet-400/55 font-medium tracking-widest uppercase mt-0.5">
            Approval required
          </p>
        </div>
        {/* Full-plan button — only shown when there's content to view */}
        {(hasPlanContent || planLoading) && (
          <button
            type="button"
            onClick={() => setPlanSheetOpen(true)}
            className="flex items-center gap-1 text-[11px] text-violet-400/50 hover:text-violet-300/80 transition-colors px-2 py-1 rounded-md hover:bg-violet-500/[0.08] border border-transparent hover:border-violet-500/15"
          >
            <Maximize2 className="size-3" />
            <span>Full plan</span>
          </button>
        )}
      </div>

      {/* ── Mode picker ────────────────────────────────────────────────── */}
      <div className="px-3.5 py-2 border-b border-violet-500/[0.08] flex items-center gap-2.5 flex-wrap">
        <span className="text-[11px] text-muted-foreground/40 shrink-0">Mode after approval:</span>
        <div className="flex gap-1">
          {MODE_OPTIONS.map(({ value, label, title }) => (
            <button
              key={value}
              type="button"
              disabled={isDisabled}
              title={title}
              onClick={() => setApprovalMode(value)}
              className={cn(
                'px-2.5 py-[3px] rounded-md text-[11px] font-medium transition-all duration-150 border',
                approvalMode === value
                  ? 'bg-violet-500/[0.18] text-violet-300 border-violet-500/35'
                  : 'bg-transparent text-muted-foreground/35 border-transparent hover:border-white/[0.08] hover:text-foreground/55',
                isDisabled && 'cursor-default opacity-60',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Action buttons ─────────────────────────────────────────────── */}
      <div className="px-3.5 py-3 space-y-2.5">
        {!feedbackMode ? (
          <>
            {/* Idle session notice */}
            {isSessionIdle && !isAnswered && (
              <div className="flex items-start gap-2 text-[11px] text-amber-400/65 bg-amber-500/[0.05] border border-amber-700/[0.18] rounded-lg px-2.5 py-2">
                <span className="shrink-0 mt-px">⏸</span>
                <span>Session is paused — approving will resume from where you left off.</span>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              {/* ▶ Implement (primary) */}
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => void handleApprove('approve')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150',
                  isDisabled
                    ? 'opacity-40 cursor-default border-white/[0.05] bg-white/[0.01] text-muted-foreground/40'
                    : 'border-violet-500/50 bg-violet-500/[0.12] text-violet-200 hover:bg-violet-500/[0.22] hover:border-violet-500/65 active:scale-[0.98]',
                )}
              >
                {pending === 'approve' ? (
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                ) : (
                  <Play className="size-3.5 shrink-0" />
                )}
                Implement
              </button>

              {/* ▶ Implement + compact */}
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => void handleApprove('compact')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150',
                  isDisabled
                    ? 'opacity-40 cursor-default border-white/[0.05] bg-white/[0.01] text-muted-foreground/40'
                    : 'border-white/[0.10] bg-white/[0.03] text-foreground/65 hover:bg-white/[0.07] hover:border-white/[0.16] active:scale-[0.98]',
                )}
              >
                {pending === 'compact' ? (
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                ) : (
                  <Layers className="size-3.5 shrink-0" />
                )}
                Implement + compact
              </button>

              {/* ↺ Restart fresh (clear context) */}
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => void handleApprove('restart')}
                title="Clear the current conversation and restart fresh with the plan as context"
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150',
                  isDisabled
                    ? 'opacity-40 cursor-default border-white/[0.05] bg-white/[0.01] text-muted-foreground/40'
                    : 'border-white/[0.10] bg-white/[0.03] text-foreground/65 hover:bg-white/[0.07] hover:border-white/[0.16] active:scale-[0.98]',
                )}
              >
                {pending === 'restart' ? (
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                ) : (
                  <RotateCcw className="size-3.5 shrink-0" />
                )}
                Restart fresh
              </button>

              {/* ✏ Revise */}
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => setFeedbackMode(true)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150',
                  isDisabled
                    ? 'opacity-40 cursor-default border-white/[0.05] bg-white/[0.01] text-muted-foreground/40'
                    : 'border-white/[0.07] bg-transparent text-muted-foreground/45 hover:bg-white/[0.04] hover:border-white/[0.12] hover:text-foreground/65 active:scale-[0.98]',
                )}
              >
                <MessageSquare className="size-3.5 shrink-0" />
                Revise
              </button>
            </div>
          </>
        ) : (
          /* ── Feedback / revise mode ─────────────────────────────────── */
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground/45">Tell Claude what to change:</p>
            <textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              disabled={isDisabled}
              rows={3}
              placeholder="Describe the changes you want…"
              className="w-full text-xs bg-black/30 border border-violet-500/20 rounded-lg px-2.5 py-2 text-foreground/75 focus:outline-none focus:border-violet-500/35 resize-y placeholder:text-muted-foreground/25 transition-colors"
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={isDisabled || !feedbackText.trim()}
                onClick={() => void handleFeedback()}
                className="bg-violet-600/80 hover:bg-violet-600 text-white border-0 text-xs h-7"
              >
                {pending === 'revise' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Send feedback
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={isDisabled}
                onClick={() => {
                  setFeedbackMode(false);
                  setFeedbackText('');
                }}
                className="text-muted-foreground hover:text-foreground text-xs h-7"
              >
                Back
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-800/30 rounded px-2 py-1">
            {error}
          </p>
        )}
      </div>

      {/* ── Plan preview ───────────────────────────────────────────────── */}
      {!feedbackMode && (
        <div className="border-t border-violet-500/[0.08] px-3.5 pt-3 pb-3.5">
          {planLoading ? (
            <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground/35">
              <Loader2 className="size-3 animate-spin" />
              Loading plan…
            </div>
          ) : hasPlanContent ? (
            <>
              {/* Scrollable preview with gradient fade */}
              <div className="relative">
                <div className="max-h-52 overflow-hidden">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={planMdComponents}>
                    {planContent ?? ''}
                  </ReactMarkdown>
                </div>
                {/* Bottom fade overlay */}
                <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[oklch(0.085_0.015_280)] to-transparent pointer-events-none" />
              </div>
              <button
                type="button"
                onClick={() => setPlanSheetOpen(true)}
                className="mt-2 flex items-center gap-1 text-[11px] text-violet-400/45 hover:text-violet-300/65 transition-colors"
              >
                <Maximize2 className="size-3" />
                View full plan
              </button>
            </>
          ) : hasAllowedPrompts ? (
            /* Fallback: show allowedPrompts when no plan file is available */
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/35 uppercase tracking-widest mb-1.5">
                Planned actions
              </p>
              {allowedPrompts.map((p, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-xs bg-black/25 rounded-md px-2 py-1.5 border border-white/[0.04]"
                >
                  <Terminal className="size-3 text-violet-400/50 shrink-0 mt-0.5" />
                  <span className="font-mono text-violet-300/65">{p.tool ?? '—'}</span>
                  {p.prompt && (
                    <span className="text-muted-foreground/40 truncate text-[11px]">
                      {p.prompt}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground/35 py-1">
              Review the plan in the conversation above, then approve or ask Claude to revise.
            </p>
          )}
        </div>
      )}

      {/* ── Full plan Sheet ─────────────────────────────────────────────── */}
      <Sheet open={planSheetOpen} onOpenChange={setPlanSheetOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-2xl bg-[oklch(0.07_0.01_280)] border-l border-violet-500/20 p-0 flex flex-col gap-0"
        >
          {/* Sheet header with inline approve button */}
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-violet-500/[0.12] shrink-0">
            <div className="p-1.5 rounded-lg bg-violet-500/[0.10] border border-violet-500/[0.15] shrink-0">
              <BookOpen className="size-3.5 text-violet-400" />
            </div>
            <SheetTitle className="text-sm font-semibold text-foreground/85 flex-1 min-w-0 truncate">
              Implementation Plan
            </SheetTitle>
            <button
              type="button"
              onClick={() => setPlanSheetOpen(false)}
              className="p-1.5 rounded-md text-muted-foreground/35 hover:text-foreground/65 hover:bg-white/[0.04] transition-colors shrink-0"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Scrollable plan body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            {hasPlanContent && (
              <div className="prose prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={planMdComponents}>
                  {planContent ?? ''}
                </ReactMarkdown>
              </div>
            )}
          </div>

          {/* Sticky action bar at sheet bottom — always visible while reading */}
          <div className="shrink-0 px-5 py-3.5 border-t border-violet-500/[0.12] bg-[oklch(0.075_0.01_280)]">
            {/* Mode picker inside sheet */}
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] text-muted-foreground/40">After approval:</span>
              <div className="flex gap-1">
                {MODE_OPTIONS.map(({ value, label, title }) => (
                  <button
                    key={value}
                    type="button"
                    disabled={isDisabled}
                    title={title}
                    onClick={() => setApprovalMode(value)}
                    className={cn(
                      'px-2.5 py-[3px] rounded-md text-[11px] font-medium transition-all duration-150 border',
                      approvalMode === value
                        ? 'bg-violet-500/[0.18] text-violet-300 border-violet-500/35'
                        : 'bg-transparent text-muted-foreground/35 border-transparent hover:border-white/[0.08] hover:text-foreground/55',
                      isDisabled && 'cursor-default opacity-60',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  void handleApprove('approve');
                  setPlanSheetOpen(false);
                }}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-xs font-medium transition-all duration-150',
                  isDisabled
                    ? 'opacity-40 cursor-default border-white/[0.05] bg-white/[0.01] text-muted-foreground/40'
                    : 'border-violet-500/50 bg-violet-500/[0.12] text-violet-200 hover:bg-violet-500/[0.22] hover:border-violet-500/65',
                )}
              >
                {pending === 'approve' ? (
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                ) : (
                  <Play className="size-3.5 shrink-0" />
                )}
                Implement
              </button>

              <button
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  void handleApprove('compact');
                  setPlanSheetOpen(false);
                }}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-xs font-medium transition-all duration-150',
                  isDisabled
                    ? 'opacity-40 cursor-default border-white/[0.05] bg-white/[0.01] text-muted-foreground/40'
                    : 'border-white/[0.10] bg-white/[0.03] text-foreground/65 hover:bg-white/[0.07] hover:border-white/[0.16]',
                )}
              >
                {pending === 'compact' ? (
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                ) : (
                  <Layers className="size-3.5 shrink-0" />
                )}
                Implement + compact
              </button>

              <button
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  setPlanSheetOpen(false);
                  void handleApprove('restart');
                }}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-xs font-medium transition-all duration-150',
                  isDisabled
                    ? 'opacity-40 cursor-default border-white/[0.05] bg-white/[0.01] text-muted-foreground/40'
                    : 'border-white/[0.10] bg-white/[0.03] text-foreground/65 hover:bg-white/[0.07] hover:border-white/[0.16]',
                )}
              >
                {pending === 'restart' ? (
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                ) : (
                  <RotateCcw className="size-3.5 shrink-0" />
                )}
                Restart fresh
              </button>

              <button
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  setPlanSheetOpen(false);
                  setFeedbackMode(true);
                }}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-xs font-medium transition-all duration-150',
                  isDisabled
                    ? 'opacity-40 cursor-default border-white/[0.05] bg-white/[0.01] text-muted-foreground/40'
                    : 'border-white/[0.07] bg-transparent text-muted-foreground/45 hover:bg-white/[0.04] hover:border-white/[0.12] hover:text-foreground/65',
                )}
              >
                <MessageSquare className="size-3.5 shrink-0" />
                Revise
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Add new interactive tools here.
 * Key = exact toolName as Claude emits it.
 */
const TOOL_RENDERERS: Partial<Record<string, InteractiveToolRenderer>> = {
  AskUserQuestion: AskUserQuestionRenderer,
  ExitPlanMode: ExitPlanModeRenderer,
  exit_plan_mode: ExitPlanModeRenderer,
};

/**
 * Look up a renderer for the given tool name.
 * Internal helper — callers should use <InteractiveTool> instead.
 */
function findToolRenderer(toolName: string): InteractiveToolRenderer | undefined {
  return TOOL_RENDERERS[toolName];
}

/**
 * Dispatcher component: renders the appropriate interactive UI for a tool,
 * or nothing if the tool has no registered renderer.
 *
 * Use this instead of calling findToolRenderer() directly in render — that
 * pattern creates a new component type on every render and breaks Fast Refresh.
 */
export function InteractiveTool({
  toolName,
  ...props
}: InteractiveToolProps & { toolName: string }) {
  const Renderer = findToolRenderer(toolName);
  if (!Renderer) return null;
  // React.createElement avoids JSX syntax so the react-hooks/static-components
  // rule (which only inspects JSX nodes) does not flag the dynamic lookup.
  // The registry always returns the same stable function reference per toolName,
  // so React will not remount the component between renders.
  return React.createElement(Renderer, props);
}
