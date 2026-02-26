'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquare } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, type ApiResponse, type ApiListResponse } from '@/lib/api-types';
import type { Agent, AgentCapability, Task } from '@/lib/types';

interface ModelOption {
  id: string;
  label: string;
  description: string;
}

/** Derive provider name from an agent binary path for model API queries. */
function deriveProvider(binaryPath: string): string {
  const base = binaryPath.split('/').pop()?.toLowerCase() ?? '';
  if (base.startsWith('claude')) return 'claude';
  if (base.startsWith('codex')) return 'codex';
  if (base.startsWith('gemini')) return 'gemini';
  return 'claude';
}

interface StartSessionDialogProps {
  taskId: string;
  agentId?: string;
}

export function StartSessionDialog({ taskId, agentId: agentIdProp }: StartSessionDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(agentIdProp ?? '');

  const activeAgentId = agentIdProp ?? selectedAgentId;

  const [promptCapId, setPromptCapId] = useState<string>('');
  const [isLoadingCaps, setIsLoadingCaps] = useState(false);
  const [isLoadingTask, setIsLoadingTask] = useState(false);
  const [promptText, setPromptText] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');

  const fetchAgents = useCallback(
    async (signal: AbortSignal) => {
      if (agentIdProp) return;
      setIsLoadingAgents(true);
      try {
        const res = await apiFetch<ApiListResponse<Agent>>('/api/agents?pageSize=50', { signal });
        if (!signal.aborted) setAgents(res.data.filter((a) => a.isActive));
      } catch {
        // ignore
      } finally {
        if (!signal.aborted) setIsLoadingAgents(false);
      }
    },
    [agentIdProp],
  );

  const fetchCapabilities = useCallback(
    async (signal: AbortSignal) => {
      if (!activeAgentId) return;
      setIsLoadingCaps(true);
      try {
        const res = await apiFetch<ApiResponse<AgentCapability[]>>(
          `/api/agents/${activeAgentId}/capabilities`,
          { signal },
        );
        if (!signal.aborted) {
          const promptCaps = res.data.filter((c) => c.isEnabled && c.interactionMode === 'prompt');
          if (promptCaps.length > 0) {
            setPromptCapId(promptCaps[0].id);
          }
        }
      } catch {
        // ignore
      } finally {
        if (!signal.aborted) setIsLoadingCaps(false);
      }
    },
    [activeAgentId],
  );

  const fetchTask = useCallback(
    async (signal: AbortSignal) => {
      setIsLoadingTask(true);
      try {
        const res = await apiFetch<ApiResponse<Task>>(`/api/tasks/${taskId}`, { signal });
        if (!signal.aborted) {
          const task = res.data;
          const lines: string[] = [];
          if (task.title) lines.push(task.title);
          if (task.description) lines.push('', task.description);
          setPromptText(lines.join('\n'));
        }
      } catch {
        // ignore — prompt stays empty
      } finally {
        if (!signal.aborted) setIsLoadingTask(false);
      }
    },
    [taskId],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;

    setSelectedAgentId(agentIdProp ?? '');
    setPromptCapId('');
    setPromptText('');
    setError(null);

    // fetchAgents and fetchTask are independent — run in parallel
    void Promise.all([fetchAgents(signal), fetchTask(signal)]);

    return () => {
      controller.abort();
    };
  }, [open, agentIdProp, fetchAgents, fetchTask]);

  useEffect(() => {
    if (!open || !activeAgentId) return;
    const controller = new AbortController();

    setPromptCapId('');
    void fetchCapabilities(controller.signal);

    return () => {
      controller.abort();
    };
  }, [open, activeAgentId, fetchCapabilities]);

  // Fetch models when agent changes
  const fetchModels = useCallback(async (signal: AbortSignal, binaryPath: string) => {
    setIsLoadingModels(true);
    setSelectedModel('');
    try {
      const provider = deriveProvider(binaryPath);
      const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`, { signal });
      if (res.ok && !signal.aborted) {
        const body = (await res.json()) as { data: ModelOption[] };
        setAvailableModels(body.data ?? []);
      }
    } catch {
      if (!signal.aborted) setAvailableModels([]);
    } finally {
      if (!signal.aborted) setIsLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !activeAgentId) return;
    const controller = new AbortController();

    // For pre-selected agents (agentIdProp), agents[] may be empty — fetch the agent directly.
    const agent = agents.find((a) => a.id === activeAgentId);
    if (agent) {
      void fetchModels(controller.signal, agent.binaryPath);
    } else {
      // Fetch agent info to get binaryPath
      apiFetch<ApiResponse<Agent>>(`/api/agents/${activeAgentId}`, { signal: controller.signal })
        .then((res) => {
          if (!controller.signal.aborted) {
            void fetchModels(controller.signal, res.data.binaryPath);
          }
        })
        .catch(() => {});
    }

    return () => controller.abort();
  }, [open, activeAgentId, agents, fetchModels]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeAgentId || !promptCapId) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch<ApiResponse<{ id: string }>>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          taskId,
          agentId: activeAgentId,
          capabilityId: promptCapId,
          initialPrompt: promptText || undefined,
          model: selectedModel || undefined,
        }),
      });
      setOpen(false);
      router.push(`/sessions/${res.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      setIsSubmitting(false);
    }
  }

  const isLoading = isLoadingAgents || isLoadingCaps || isLoadingTask;
  const canSubmit = !!activeAgentId && !!promptCapId && !isSubmitting && !isLoading;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <MessageSquare className="size-4" />
          Start Session
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Start Session</DialogTitle>
          <DialogDescription>
            The agent will work on this task. Edit the prompt below if needed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {!agentIdProp && (
              <div className="space-y-2">
                <Label htmlFor="session-agent">Agent</Label>
                {isLoadingAgents ? (
                  <Skeleton className="h-9 w-full" />
                ) : (
                  <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                    <SelectTrigger id="session-agent" className="w-full">
                      <SelectValue placeholder="Select an agent..." />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {activeAgentId && (
              <div className="space-y-2">
                <Label htmlFor="session-model">Model (optional)</Label>
                {isLoadingModels ? (
                  <Skeleton className="h-9 w-full" />
                ) : availableModels.length > 0 ? (
                  <Select value={selectedModel} onValueChange={setSelectedModel}>
                    <SelectTrigger id="session-model" className="w-full">
                      <SelectValue placeholder="Default model" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground/50">
                    No models found — using agent default.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="initial-prompt">Prompt</Label>
              {isLoadingTask ? (
                <Skeleton className="h-[160px] w-full" />
              ) : (
                <Textarea
                  id="initial-prompt"
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  placeholder="Describe what you want the agent to do..."
                  className="min-h-[160px] resize-y"
                />
              )}
              <p className="text-xs text-muted-foreground">
                Pre-filled from the task. Edit freely before starting.
              </p>
            </div>
          </div>

          {error && <p className="shrink-0 text-sm text-destructive">{error}</p>}

          <DialogFooter className="shrink-0">
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MessageSquare className="size-4" />
              )}
              Start Session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
