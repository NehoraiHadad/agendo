'use client';

import { useState, useEffect } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
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

export type ContextMode = 'hybrid' | 'full';

interface AgentOption {
  id: string;
  name: string;
  capabilityId: string;
}

interface AgentWithCapabilities {
  id: string;
  name: string;
  isActive: boolean;
  capabilities: Array<{ id: string; interactionMode: string }>;
}

interface ForkResponse {
  data: {
    sessionId: string;
    agentId: string;
    agentName: string;
    contextMeta: {
      totalTurns: number;
      includedVerbatimTurns: number;
      estimatedTokens: number;
    };
  };
}

export interface AgentSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceAgentName: string;
  /** Pass empty string to enter picker mode (mobile) */
  targetAgentId: string;
  targetAgentName: string;
  targetCapabilityId: string;
  sessionId: string;
  onSuccess: (newSessionId: string) => void;
}

export function AgentSwitchDialog({
  open,
  onOpenChange,
  sourceAgentName,
  targetAgentId,
  targetAgentName,
  targetCapabilityId,
  sessionId,
  onSuccess,
}: AgentSwitchDialogProps) {
  // Picker mode: targetAgentId is empty — user needs to choose agent first
  const pickerMode = targetAgentId === '';

  const [contextMode, setContextMode] = useState<ContextMode>('hybrid');
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Picker state (only used when pickerMode)
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [pickedAgent, setPickedAgent] = useState<AgentOption | null>(null);

  // Resolved target (either from props or picker)
  const resolvedAgentId = pickerMode ? (pickedAgent?.id ?? '') : targetAgentId;
  const resolvedAgentName = pickerMode ? (pickedAgent?.name ?? '') : targetAgentName;

  // Reset all state when dialog closes
  useEffect(() => {
    if (!open) {
      setContextMode('hybrid');
      setAdditionalInstructions('');
      setError(null);
      setIsSubmitting(false);
      setPickedAgent(null);
      setAgents([]);
    }
  }, [open]);

  // Fetch agents when in picker mode and dialog opens
  useEffect(() => {
    if (!open || !pickerMode) return;
    const controller = new AbortController();
    // Set loading inside a microtask to avoid synchronous setState-in-effect lint rule
    Promise.resolve().then(() => setLoadingAgents(true));
    fetch('/api/agents?capabilities=true', { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ data: AgentWithCapabilities[] }>) : null))
      .then((body) => {
        if (controller.signal.aborted || !body?.data) {
          setLoadingAgents(false);
          return;
        }
        const rows: AgentOption[] = [];
        for (const agent of body.data) {
          if (!agent.isActive) continue;
          const cap = agent.capabilities.find((c) => c.interactionMode === 'prompt');
          if (cap) rows.push({ id: agent.id, name: agent.name, capabilityId: cap.id });
        }
        setAgents(rows);
        setLoadingAgents(false);
      })
      .catch(() => setLoadingAgents(false));
    return () => controller.abort();
  }, [open, pickerMode]);

  async function handleSubmit() {
    if (isSubmitting || !resolvedAgentId) return;
    setIsSubmitting(true);
    setError(null);
    const capId = pickerMode ? (pickedAgent?.capabilityId ?? '') : targetCapabilityId;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/fork-to-agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: resolvedAgentId,
          capabilityId: capId,
          contextMode,
          ...(additionalInstructions.trim()
            ? { additionalInstructions: additionalInstructions.trim() }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const body = (await res.json()) as ForkResponse;
      onSuccess(body.data.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsSubmitting(false);
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
              ) : agents.length === 0 ? (
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
              disabled={isSubmitting || !resolvedAgentId}
              className="gap-1.5"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>
                    {contextMode === 'hybrid'
                      ? 'Summarizing & switching...'
                      : `Creating session with ${resolvedAgentName}...`}
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
