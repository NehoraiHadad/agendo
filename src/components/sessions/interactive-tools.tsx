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

import React, { useState } from 'react';
import { Check, X, Loader2, BookOpen, CheckCircle2, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

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
  | { kind: 'approval'; decision: 'allow' | 'deny' | 'allow-session' };

export interface InteractiveToolProps {
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

  const [selections, setSelections] = useState<Record<number, Set<string>>>(() =>
    Object.fromEntries(questions.map((_, i) => [i, new Set<string>()])),
  );
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDone = submitted || isAnswered;
  const canSubmit = !isDone && questions.every((_, i) => (selections[i]?.size ?? 0) > 0);

  function handleToggle(qIdx: number, optLabel: string, multiSelect: boolean) {
    if (isDone) return;
    setSelections((prev) => {
      const next = { ...prev };
      const set = new Set(next[qIdx]);
      if (multiSelect) {
        if (set.has(optLabel)) set.delete(optLabel);
        else set.add(optLabel);
      } else {
        set.clear();
        set.add(optLabel);
      }
      next[qIdx] = set;
      return next;
    });
  }

  async function handleSubmit() {
    if (!canSubmit || loading) return;
    setLoading(true);
    setError(null);

    const answers: Record<string, string | string[]> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const selected = [...(selections[i] ?? [])];
      answers[q.question] = q.multiSelect ? selected : (selected[0] ?? '');
    }

    try {
      await respond({ kind: 'tool-result', content: JSON.stringify({ answers }) });
      setSubmitted(true);
      onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className={cn(
        'rounded-xl border p-4 space-y-4 text-sm',
        isDone
          ? 'border-primary/15 bg-primary/[0.04] opacity-75'
          : 'border-primary/30 bg-primary/[0.07]',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        {isDone ? (
          <CheckCircle2 className="size-3.5 text-primary/60 shrink-0" />
        ) : (
          <span className="size-2 rounded-full bg-primary animate-pulse shrink-0" />
        )}
        <span className="text-[10px] font-semibold uppercase tracking-widest text-primary/60">
          {isDone ? 'Answered' : 'Awaiting your input'}
        </span>
      </div>

      {/* Questions */}
      {questions.map((q, qIdx) => (
        <div key={qIdx} className="space-y-2">
          <p className="font-medium text-foreground/90 leading-relaxed">{q.question}</p>
          {q.multiSelect && (
            <p className="text-xs text-muted-foreground/50">Select all that apply</p>
          )}
          <div className="space-y-1.5">
            {q.options.map((opt) => {
              const isSelected = selections[qIdx]?.has(opt.label) ?? false;
              return (
                <button
                  key={opt.label}
                  type="button"
                  disabled={isDone}
                  onClick={() => handleToggle(qIdx, opt.label, q.multiSelect ?? false)}
                  className={cn(
                    'w-full text-left rounded-lg border px-3 py-2.5 transition-all duration-150',
                    'flex items-start gap-2.5',
                    isSelected
                      ? 'border-primary/50 bg-primary/10 shadow-[0_0_10px_oklch(0.7_0.18_280/0.10)]'
                      : 'border-white/[0.07] bg-white/[0.02] hover:border-primary/25 hover:bg-primary/[0.04]',
                    isDone && 'cursor-default',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 h-3.5 w-3.5 border-2 transition-all duration-150 flex items-center justify-center',
                      q.multiSelect ? 'rounded-sm' : 'rounded-full',
                      isSelected ? 'border-primary bg-primary' : 'border-white/20',
                    )}
                  >
                    {isSelected && (
                      <span
                        className={cn(
                          'bg-white block',
                          q.multiSelect ? 'h-1.5 w-1.5 rounded-[1px]' : 'h-1.5 w-1.5 rounded-full',
                        )}
                      />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'text-sm',
                        isSelected ? 'text-foreground' : 'text-foreground/70',
                      )}
                    >
                      {opt.label}
                    </span>
                    {opt.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground/50 leading-relaxed">
                        {opt.description}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {error && (
        <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-800/30 rounded px-2 py-1">
          {error}
        </p>
      )}

      {!isDone && (
        <button
          type="button"
          disabled={!canSubmit || loading}
          onClick={() => void handleSubmit()}
          className={cn(
            'w-full rounded-lg py-2 text-sm font-medium transition-all duration-200',
            canSubmit && !loading
              ? 'bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 hover:border-primary/50'
              : 'bg-white/[0.03] text-muted-foreground/30 border border-white/[0.05] cursor-not-allowed',
          )}
        >
          {loading ? <Loader2 className="size-4 animate-spin mx-auto" /> : 'Submit Answer'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExitPlanMode renderer
// ---------------------------------------------------------------------------

interface AllowedPrompt {
  tool?: string;
  prompt?: string;
}

function ExitPlanModeRenderer({ input, isAnswered, respond, onResolved }: InteractiveToolProps) {
  const [pending, setPending] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDisabled = isAnswered || pending !== null;

  const allowedPrompts = Array.isArray(input.allowedPrompts)
    ? (input.allowedPrompts as AllowedPrompt[])
    : [];

  async function handleDecision(decision: 'allow' | 'deny') {
    setError(null);
    setPending(decision);
    try {
      await respond({ kind: 'approval', decision });
      onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      setPending(null);
    }
  }

  if (isAnswered && pending !== 'deny') {
    return (
      <div className="rounded-md border border-violet-500/15 bg-violet-500/[0.03] px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground/60">
        <CheckCircle2 className="size-3.5 text-violet-400/60 shrink-0" />
        <span>Plan approved — implementing</span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-violet-500/30 bg-violet-500/[0.06] p-3 space-y-3 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2">
        <BookOpen className="size-3.5 text-violet-400 shrink-0" />
        <span className="font-medium text-foreground/90">Plan ready — your approval required</span>
      </div>

      {/* Plan steps (allowedPrompts) */}
      {allowedPrompts.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground/50 mb-1.5">Planned actions:</p>
          {allowedPrompts.map((p, i) => (
            <div
              key={i}
              className="flex items-start gap-2 text-xs bg-black/30 rounded px-2 py-1.5 border border-white/[0.05]"
            >
              <Terminal className="size-3 text-violet-400/60 shrink-0 mt-0.5" />
              <span className="font-mono text-violet-300/80">{p.tool ?? '—'}</span>
              {p.prompt && <span className="text-muted-foreground/50 truncate">{p.prompt}</span>}
            </div>
          ))}
        </div>
      )}

      {allowedPrompts.length === 0 && (
        <p className="text-xs text-muted-foreground/60">
          Review the plan in the conversation above, then approve or ask Claude to revise.
        </p>
      )}

      {error && (
        <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-800/30 rounded px-2 py-1">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={isDisabled}
          onClick={() => void handleDecision('allow')}
          className="bg-violet-600/80 hover:bg-violet-600 text-white border-0"
        >
          {pending === 'allow' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          Proceed
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={isDisabled}
          onClick={() => void handleDecision('deny')}
          className="text-muted-foreground hover:text-foreground"
        >
          {pending === 'deny' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <X className="size-3.5" />
          )}
          Revise plan
        </Button>
      </div>
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
