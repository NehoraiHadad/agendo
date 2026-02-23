'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types matching the AskUserQuestion tool input schema
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

interface AskUserQuestionCardProps {
  sessionId: string;
  toolUseId: string;
  questions: Question[];
  /** True once the tool result has been received (tool.result exists). */
  isAnswered?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AskUserQuestionCard({
  sessionId,
  toolUseId,
  questions,
  isAnswered = false,
}: AskUserQuestionCardProps) {
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

    // Build answer JSON matching Claude's expected AskUserQuestion result format.
    const answers: Record<string, string | string[]> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const selected = [...(selections[i] ?? [])];
      answers[q.question] = q.multiSelect ? selected : (selected[0] ?? '');
    }
    const content = JSON.stringify({ answers });

    try {
      const res = await fetch(`/api/sessions/${sessionId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tool-result', toolUseId, content }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }
      setSubmitted(true);
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
                  {/* Radio / checkbox indicator */}
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

      {/* Error */}
      {error && (
        <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-800/30 rounded px-2 py-1">
          {error}
        </p>
      )}

      {/* Submit */}
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
