'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowRight, Loader2, Sparkles, Scissors } from 'lucide-react';
import { useFetch } from '@/hooks/use-fetch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { getTeamColor } from '@/lib/utils/team-colors';
import { agentColorKey, agentPillClass } from '@/lib/utils/agent-switch-colors';
import { getErrorMessage } from '@/lib/utils/error-utils';

export type ContextMode = 'hybrid' | 'full';

interface AgentOption {
  id: string;
  name: string;
}

interface AgentSimple {
  id: string;
  name: string;
  isActive: boolean;
}

interface ContextMeta {
  totalTurns: number;
  includedVerbatimTurns: number;
  summarizedTurns: number;
  estimatedTokens: number;
  previousAgent: string;
  taskTitle?: string;
  projectName?: string;
  llmSummarized?: boolean;
}

interface ForkResponse {
  data: {
    sessionId: string;
    agentId: string;
    agentName: string;
    contextMeta: ContextMeta;
  };
}

export interface AgentSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceAgentName: string;
  /** Pass empty string to enter picker mode (mobile) */
  targetAgentId: string;
  targetAgentName: string;
  sessionId: string;
  onSuccess: (newSessionId: string) => void;
}

/** Threshold in ms after which we show a "taking longer than usual" hint */
const SLOW_THRESHOLD_MS = 8_000;

function ContextMetaBadge({ meta }: { meta: ContextMeta }) {
  if (meta.totalTurns === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50">
        No conversation history transferred
      </span>
    );
  }

  if (meta.llmSummarized) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400/70">
        <Sparkles className="size-3" />
        AI-summarized {meta.summarizedTurns} older turns + {meta.includedVerbatimTurns} verbatim
      </span>
    );
  }

  if (meta.summarizedTurns > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-400/70">
        <Scissors className="size-3" />
        Truncated fallback ({meta.includedVerbatimTurns} of {meta.totalTurns} turns)
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50">
      {meta.includedVerbatimTurns} turns transferred verbatim
    </span>
  );
}

export function AgentSwitchDialog({
  open,
  onOpenChange,
  sourceAgentName,
  targetAgentId,
  targetAgentName,
  sessionId,
  onSuccess,
}: AgentSwitchDialogProps) {
  // Picker mode: targetAgentId is empty — user needs to choose agent first
  const pickerMode = targetAgentId === '';

  const [contextMode, setContextMode] = useState<ContextMode>('hybrid');
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSlow, setIsSlow] = useState(false);
  const [resultMeta, setResultMeta] = useState<ContextMeta | null>(null);

  // Picker state (only used when pickerMode)
  const [pickedAgent, setPickedAgent] = useState<AgentOption | null>(null);

  const { data: agents, isLoading: loadingAgents } = useFetch<AgentOption[]>(
    open && pickerMode ? '/api/agents?group=ai' : null,
    {
      transform: (json: unknown) => {
        const body = json as { data: AgentSimple[] } | null;
        return (body?.data ?? [])
          .filter((a) => a.isActive)
          .map((a) => ({ id: a.id, name: a.name }));
      },
    },
  );

  // AbortController for the fork request
  const forkAbortRef = useRef<AbortController | null>(null);
  // Submission generation counter to guard against stale completions
  const submitGenRef = useRef(0);
  // Timer for slow-request hint
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolved target (either from props or picker)
  const resolvedAgentId = pickerMode ? (pickedAgent?.id ?? '') : targetAgentId;
  const resolvedAgentName = pickerMode ? (pickedAgent?.name ?? '') : targetAgentName;

  // Cancel in-flight fork request
  const cancelFork = useCallback(() => {
    if (forkAbortRef.current) {
      forkAbortRef.current.abort();
      forkAbortRef.current = null;
    }
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
  }, []);

  // Reset all state when dialog closes + abort any in-flight request
  useEffect(() => {
    if (!open) {
      cancelFork();
      submitGenRef.current++;
      setContextMode('hybrid');
      setAdditionalInstructions('');
      setError(null);
      setIsSubmitting(false);
      setIsSlow(false);
      setResultMeta(null);
      setPickedAgent(null);
    }
  }, [open, cancelFork]);

  // Cleanup on unmount — increment gen to invalidate any in-flight submissions
  useEffect(() => {
    const ref = submitGenRef;
    return () => {
      cancelFork();
      ref.current++;
    };
  }, [cancelFork]);

  async function handleSubmit() {
    if (isSubmitting || !resolvedAgentId) return;

    // Cancel any previous in-flight request
    cancelFork();

    const gen = ++submitGenRef.current;
    const controller = new AbortController();
    forkAbortRef.current = controller;

    setIsSubmitting(true);
    setError(null);
    setIsSlow(false);
    setResultMeta(null);

    // Start slow-request timer
    slowTimerRef.current = setTimeout(() => setIsSlow(true), SLOW_THRESHOLD_MS);

    try {
      const res = await fetch(`/api/sessions/${sessionId}/fork-to-agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          agentId: resolvedAgentId,
          contextMode,
          ...(additionalInstructions.trim()
            ? { additionalInstructions: additionalInstructions.trim() }
            : {}),
        }),
      });

      // Guard: if this submission is stale (dialog closed or new submit started), bail
      if (gen !== submitGenRef.current) return;

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg =
          typeof body?.error === 'string'
            ? body.error
            : typeof body?.error?.message === 'string'
              ? body.error.message
              : `Request failed (${res.status})`;
        throw new Error(msg);
      }
      const body = (await res.json()) as ForkResponse;

      // Guard again after second await
      if (gen !== submitGenRef.current) return;

      // Show context meta briefly before navigating
      setResultMeta(body.data.contextMeta);
      setIsSubmitting(false);
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }

      // Short delay to let user see the context summary badge
      setTimeout(() => {
        if (gen !== submitGenRef.current) return;
        onSuccess(body.data.sessionId);
      }, 1200);
    } catch (err) {
      if (gen !== submitGenRef.current) return;
      // Don't show error for user-initiated abort
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(getErrorMessage(err));
      setIsSubmitting(false);
    } finally {
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-white/[0.08] bg-[oklch(0.10_0_0)]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Switch agent</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* --- PICKER STEP (mobile: no pre-selected agent) --- */}
          {pickerMode && !pickedAgent && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground/50 mb-1">Choose an agent to switch to:</p>
              {loadingAgents ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="size-4 animate-spin text-muted-foreground/40" />
                </div>
              ) : !agents || agents.length === 0 ? (
                <p className="text-xs text-muted-foreground/40 py-4 text-center">
                  No agents available
                </p>
              ) : (
                agents.map((agent) => {
                  const colorKey = agentColorKey(agent.name);
                  const color = getTeamColor(colorKey);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => setPickedAgent(agent)}
                      className="flex items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3.5 py-3 text-left hover:border-orange-500/20 hover:bg-orange-500/[0.04] transition-colors"
                    >
                      <span className={`size-2 rounded-full shrink-0 ${color.pulse}`} />
                      <span className="flex-1 text-sm text-foreground/80">{agent.name}</span>
                      <ArrowRight className="size-3.5 text-muted-foreground/25 shrink-0" />
                    </button>
                  );
                })
              )}
            </div>
          )}

          {/* --- CONFIRMATION STEP --- */}
          {(!pickerMode || pickedAgent) && (
            <>
              {/* Transition visualization */}
              <div className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-3.5 py-3">
                <span
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${agentPillClass(sourceAgentName)}`}
                >
                  {sourceAgentName}
                </span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/30" />
                <span
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${agentPillClass(resolvedAgentName)}`}
                >
                  {resolvedAgentName}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground/30 font-mono">
                  new session
                </span>
              </div>

              {/* Context mode */}
              <div className="flex flex-col gap-2.5">
                <Label className="text-xs font-medium text-muted-foreground/60">Context mode</Label>
                <RadioGroup
                  value={contextMode}
                  onValueChange={(v) => setContextMode(v as ContextMode)}
                  className="gap-2"
                >
                  <label
                    htmlFor="ctx-hybrid"
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
                      contextMode === 'hybrid'
                        ? 'border-orange-500/30 bg-orange-500/[0.05]'
                        : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]'
                    }`}
                  >
                    <RadioGroupItem value="hybrid" id="ctx-hybrid" className="mt-0.5 shrink-0" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-foreground/80">
                        Hybrid
                        <span className="ml-1.5 text-[10px] font-normal text-orange-400/70 border border-orange-500/20 bg-orange-500/[0.08] rounded px-1 py-px">
                          recommended
                        </span>
                      </span>
                      <span className="text-[11px] text-muted-foreground/45 leading-relaxed">
                        AI-generated summary of older turns + last 5 verbatim
                      </span>
                    </div>
                  </label>

                  <label
                    htmlFor="ctx-full"
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
                      contextMode === 'full'
                        ? 'border-orange-500/30 bg-orange-500/[0.05]'
                        : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]'
                    }`}
                  >
                    <RadioGroupItem value="full" id="ctx-full" className="mt-0.5 shrink-0" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-foreground/80">
                        Full transcript
                      </span>
                      <span className="text-[11px] text-muted-foreground/45 leading-relaxed">
                        All turns included verbatim — higher token cost
                      </span>
                    </div>
                  </label>
                </RadioGroup>
              </div>

              {/* Additional instructions */}
              <div className="flex flex-col gap-2">
                <Label
                  htmlFor="additional-instructions"
                  className="text-xs font-medium text-muted-foreground/60"
                >
                  Additional instructions
                  <span className="ml-1.5 text-[10px] text-muted-foreground/30 font-normal">
                    optional
                  </span>
                </Label>
                <Textarea
                  id="additional-instructions"
                  rows={3}
                  placeholder="e.g., Focus on the failing tests"
                  maxLength={2000}
                  value={additionalInstructions}
                  onChange={(e) => setAdditionalInstructions(e.target.value)}
                  className="resize-none border-white/[0.10] bg-white/[0.04] text-xs placeholder:text-muted-foreground/30"
                />
                {additionalInstructions.length > 1800 && (
                  <p className="text-[10px] text-muted-foreground/40 text-right">
                    {additionalInstructions.length}/2000
                  </p>
                )}
              </div>

              {/* Info note */}
              <p className="text-xs text-muted-foreground/50 leading-relaxed">
                The current session stays open. You can return to it anytime.
              </p>
            </>
          )}
        </div>

        {/* Context meta result */}
        {resultMeta && (
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3.5 py-2.5">
            <ContextMetaBadge meta={resultMeta} />
          </div>
        )}

        {/* Error */}
        {error && <p className="text-sm text-red-400">{error}</p>}

        <DialogFooter>
          {pickerMode && pickedAgent ? (
            <Button
              variant="ghost"
              onClick={() => setPickedAgent(null)}
              disabled={isSubmitting}
              className="text-muted-foreground/60 hover:text-foreground/80"
            >
              Back
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              className="text-muted-foreground/60 hover:text-foreground/80"
            >
              Cancel
            </Button>
          )}

          {/* Only show the switch button when a target is selected */}
          {(!pickerMode || pickedAgent) && (
            <Button
              onClick={() => void handleSubmit()}
              disabled={isSubmitting || !resolvedAgentId || resultMeta !== null}
              className="gap-1.5"
            >
              {resultMeta ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Redirecting...</span>
                </>
              ) : isSubmitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span className="flex flex-col items-start">
                    <span>
                      {contextMode === 'hybrid'
                        ? 'Summarizing & switching...'
                        : `Creating session with ${resolvedAgentName}...`}
                    </span>
                    {isSlow && (
                      <span className="text-[10px] text-muted-foreground/40 font-normal">
                        AI summarization can take a moment
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <span>Switch Agent</span>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
