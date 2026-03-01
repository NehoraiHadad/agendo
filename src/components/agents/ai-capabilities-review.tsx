'use client';

import { useState, useTransition } from 'react';
import { Bot, ChevronDown, ChevronUp, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { AICapabilitySuggestion } from '@/lib/actions/capability-analysis-action';
import type { AgentCapability } from '@/lib/types';

interface AICapabilitiesReviewProps {
  agentId: string;
  onCreated: (caps: AgentCapability[]) => void;
}

const DANGER_LABELS = ['Safe', 'Low risk', 'Caution', 'Destructive'] as const;
const DANGER_COLORS = [
  'text-green-600 border-green-300',
  'text-yellow-600 border-yellow-300',
  'text-orange-500 border-orange-300',
  'text-red-600 border-red-300',
] as const;

export function AICapabilitiesReview({ agentId, onCreated }: AICapabilitiesReviewProps) {
  const [open, setOpen] = useState(false);
  const [isAnalyzing, startAnalysis] = useTransition();
  const [isSaving, startSave] = useTransition();
  const [suggestions, setSuggestions] = useState<AICapabilitySuggestion[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'analyzing' | 'review' | 'done'>('idle');

  function handleOpen(v: boolean) {
    setOpen(v);
    if (!v) {
      setPhase('idle');
      setSuggestions([]);
      setSelected(new Set());
      setExpanded(new Set());
      setError(null);
    }
  }

  function handleAnalyze() {
    setError(null);
    setPhase('analyzing');
    startAnalysis(async () => {
      try {
        // Start job
        const startRes = await fetch(`/api/agents/${agentId}/analyze`, { method: 'POST' });
        const { jobId } = (await startRes.json()) as { jobId: string };

        // Poll until done (max 3 minutes)
        const result = await new Promise<{
          status: string;
          suggestions?: AICapabilitySuggestion[];
          error?: string;
        }>((resolve) => {
          const deadline = Date.now() + 3 * 60 * 1000;
          const poll = () => {
            if (Date.now() > deadline) {
              resolve({ status: 'error', error: 'Analysis timed out. Try again.' });
              return;
            }
            fetch(`/api/agents/${agentId}/analyze?job=${jobId}`)
              .then((r) => r.json())
              .then(
                (data: {
                  status: string;
                  suggestions?: AICapabilitySuggestion[];
                  error?: string;
                }) => {
                  if (data.status === 'pending') {
                    setTimeout(poll, 2000);
                  } else {
                    resolve(data);
                  }
                },
              )
              .catch(() => setTimeout(poll, 2000));
          };
          setTimeout(poll, 2000);
        });

        if (result.status === 'error' || !result.suggestions?.length) {
          setError(result.error ?? 'No suggestions returned.');
          setPhase('idle');
          return;
        }
        setSuggestions(result.suggestions);
        setSelected(new Set(result.suggestions.map((_, i) => i)));
        setPhase('review');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Analysis failed');
        setPhase('idle');
      }
    });
  }

  function toggleSelect(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function toggleExpand(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function handleSave() {
    const toSave = suggestions.filter((_, i) => selected.has(i));
    if (!toSave.length) return;

    startSave(async () => {
      const created: AgentCapability[] = [];
      const errors: string[] = [];

      for (const s of toSave) {
        try {
          const res = await apiFetch<ApiResponse<AgentCapability>>(
            `/api/agents/${agentId}/capabilities`,
            {
              method: 'POST',
              body: JSON.stringify({
                key: s.key,
                label: s.label,
                description: s.description,
                interactionMode: 'template',
                commandTokens: s.commandTokens,
                argsSchema: s.argsSchema,
                dangerLevel: s.dangerLevel,
              }),
            },
          );
          created.push(res.data);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : `Failed: ${s.label}`);
        }
      }

      if (created.length) onCreated(created);
      if (errors.length) {
        setError(errors.join('; '));
      } else {
        setPhase('done');
        setTimeout(() => setOpen(false), 800);
      }
    });
  }

  const selectedCount = selected.size;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="px-2 sm:px-3 text-purple-400 border-purple-500/30 hover:bg-purple-500/10"
          title="AI Analyze"
        >
          <Sparkles className="size-4" />
          <span className="hidden sm:inline ml-1.5">AI Analyze</span>
        </Button>
      </DialogTrigger>

      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5 text-purple-400" />
            AI Capability Analysis
          </DialogTitle>
          <DialogDescription>
            Claude will analyze this tool&apos;s --help output and suggest capabilities with
            structured arguments.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {/* Analyzing phase */}
          {phase === 'analyzing' && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8">
              <Loader2 className="size-8 animate-spin text-purple-400" />
              <p className="text-sm text-muted-foreground">AI is analyzing the tool…</p>
              <p className="text-xs text-muted-foreground/60">This takes ~30–60 seconds</p>
            </div>
          )}

          {/* Idle phase */}
          {phase === 'idle' && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8">
              <Sparkles className="size-10 text-purple-400/60" />
              <div className="text-center">
                <p className="text-sm font-medium">Analyze with Claude</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Claude will read the tool&apos;s --help and suggest capabilities with proper
                  argument placeholders (like{' '}
                  <code className="rounded bg-muted px-1 font-mono text-xs">{'{{message}}'}</code>).
                </p>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button onClick={handleAnalyze} disabled={isAnalyzing}>
                <Sparkles className="size-4" />
                Start Analysis
              </Button>
            </div>
          )}

          {/* Done */}
          {phase === 'done' && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8">
              <p className="text-sm text-green-400">Saved {selectedCount} capabilities ✓</p>
            </div>
          )}

          {/* Review phase */}
          {phase === 'review' && (
            <>
              <div className="flex items-center justify-between shrink-0">
                <p className="text-sm text-muted-foreground">
                  {suggestions.length} suggestions — {selectedCount} selected
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7"
                    onClick={() => setSelected(new Set(suggestions.map((_, i) => i)))}
                  >
                    All
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7"
                    onClick={() => setSelected(new Set())}
                  >
                    None
                  </Button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {suggestions.map((s, i) => {
                  const isSelected = selected.has(i);
                  const isExpanded = expanded.has(i);
                  const dangerColor = DANGER_COLORS[Math.min(s.dangerLevel, 3)];
                  const dangerLabel = DANGER_LABELS[Math.min(s.dangerLevel, 3)];
                  const argCount = Object.keys(s.argsSchema?.properties ?? {}).length;

                  return (
                    <div
                      key={i}
                      className={`rounded-md border transition-colors ${
                        isSelected
                          ? 'border-purple-500/40 bg-purple-500/5'
                          : 'border-border/50 opacity-50'
                      }`}
                    >
                      <div className="flex items-center gap-3 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(i)}
                          className="h-4 w-4 rounded"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">{s.label}</span>
                            <code className="font-mono text-xs text-muted-foreground/70 truncate">
                              {s.commandTokens.join(' ')}
                            </code>
                          </div>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {s.description}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="outline" className={`text-xs ${dangerColor}`}>
                            {dangerLabel}
                          </Badge>
                          {argCount > 0 && (
                            <Badge variant="secondary" className="text-xs">
                              {argCount} arg{argCount !== 1 ? 's' : ''}
                            </Badge>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-6"
                            onClick={() => toggleExpand(i)}
                          >
                            {isExpanded ? (
                              <ChevronUp className="size-3" />
                            ) : (
                              <ChevronDown className="size-3" />
                            )}
                          </Button>
                        </div>
                      </div>

                      {isExpanded && argCount > 0 && (
                        <div className="border-t border-border/40 px-3 py-2 space-y-1">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Arguments
                          </p>
                          {Object.entries(s.argsSchema.properties ?? {}).map(([key, prop]) => (
                            <div key={key} className="flex items-start gap-2 text-xs">
                              <code className="font-mono text-purple-400 shrink-0">
                                {'{{'}
                                {key}
                                {'}}'}
                              </code>
                              <span className="text-muted-foreground">
                                {prop.description}
                                {s.argsSchema.required?.includes(key) && (
                                  <span className="text-destructive ml-1">*</span>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {error && <p className="shrink-0 text-sm text-destructive">{error}</p>}

              <DialogFooter className="shrink-0">
                <Button variant="outline" onClick={() => handleOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={selectedCount === 0 || isSaving}
                  className="bg-purple-600 hover:bg-purple-700"
                >
                  {isSaving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  Save {selectedCount} Capabilities
                </Button>
              </DialogFooter>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
