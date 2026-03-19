'use client';

import { useEffect, useState, useCallback } from 'react';
import { useDraft } from '@/hooks/use-draft';
import { useRouter } from 'next/navigation';
import { useFormSubmit } from '@/hooks/use-form-submit';
import { ChevronDown, ChevronRight, GitBranch, Loader2, MessageSquare, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import { ErrorAlert } from '@/components/ui/error-alert';
import { apiFetch, type ApiResponse, type ApiListResponse } from '@/lib/api-types';
import type { Agent, McpServer, Task } from '@/lib/types';
import { deriveProvider } from '@/lib/utils/session-controls';

interface ModelOption {
  id: string;
  label: string;
  description: string;
  isDefault?: boolean;
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

  const [isLoadingTask, setIsLoadingTask] = useState(false);
  const [promptText, setPromptText] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set());
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('');

  const { saveDraft, getDraft, clearDraft } = useDraft(`draft:session-new:${taskId}`);

  const {
    isSubmitting,
    error,
    setError,
    handleSubmit: submitForm,
  } = useFormSubmit(async () => {
    const parsedBudget = maxBudgetUsd ? parseFloat(maxBudgetUsd) : undefined;
    const res = await apiFetch<ApiResponse<{ id: string }>>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        taskId,
        agentId: activeAgentId,
        initialPrompt: promptText || undefined,
        model: selectedModel || undefined,
        mcpServerIds: selectedMcpIds.size > 0 ? [...selectedMcpIds] : undefined,
        useWorktree: useWorktree || undefined,
        maxBudgetUsd:
          parsedBudget != null && !isNaN(parsedBudget) && parsedBudget > 0
            ? parsedBudget
            : undefined,
      }),
    });
    clearDraft();
    setOpen(false);
    router.push(`/sessions/${res.data.id}`);
  });

  const fetchAgents = useCallback(
    async (signal: AbortSignal) => {
      if (agentIdProp) return;
      setIsLoadingAgents(true);
      try {
        const res = await apiFetch<ApiListResponse<Agent>>('/api/agents?pageSize=50&group=ai', {
          signal,
        });
        if (!signal.aborted) setAgents(res.data.filter((a) => a.isActive));
      } catch {
        // ignore
      } finally {
        if (!signal.aborted) setIsLoadingAgents(false);
      }
    },
    [agentIdProp],
  );

  // Track the selected agent's binaryPath for feature-gating (worktree support)
  const [selectedBinaryPath, setSelectedBinaryPath] = useState('');
  const isClaudeAgent = deriveProvider(selectedBinaryPath) === 'claude';

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
    setError(null);
    setSelectedMcpIds(new Set());
    setMcpExpanded(false);
    setAdvancedExpanded(false);
    setMaxBudgetUsd('');

    // Fetch enabled MCP servers
    fetch('/api/mcp-servers?enabled=true', { signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: McpServer[]) => {
        if (!signal.aborted) {
          setMcpServers(data);
          // Pre-select defaults
          setSelectedMcpIds(new Set(data.filter((s) => s.isDefault).map((s) => s.id)));
        }
      })
      .catch(() => {});

    // If there's a saved draft, restore it and skip the task prefill
    const saved = getDraft();
    if (saved) {
      setPromptText(saved);
      void fetchAgents(signal);
    } else {
      setPromptText('');
      void Promise.all([fetchAgents(signal), fetchTask(signal)]);
    }

    return () => {
      controller.abort();
    };
  }, [open, agentIdProp, fetchAgents, fetchTask, getDraft, setError]);

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
      setSelectedBinaryPath(agent.binaryPath);
      void fetchModels(controller.signal, agent.binaryPath);
    } else {
      // Fetch agent info to get binaryPath
      apiFetch<ApiResponse<Agent>>(`/api/agents/${activeAgentId}`, { signal: controller.signal })
        .then((res) => {
          if (!controller.signal.aborted) {
            setSelectedBinaryPath(res.data.binaryPath);
            void fetchModels(controller.signal, res.data.binaryPath);
          }
        })
        .catch(() => {});
    }

    return () => controller.abort();
  }, [open, activeAgentId, agents, fetchModels]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeAgentId) return;
    await submitForm();
  }

  const isLoading = isLoadingAgents || isLoadingTask;
  const canSubmit = !!activeAgentId && !isSubmitting && !isLoading;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <MessageSquare className="size-4" />
          Start Session
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start Session</DialogTitle>
          <DialogDescription>
            The agent will work on this task. Edit the prompt below if needed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4">
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
                <Label htmlFor="session-model">Model</Label>
                {isLoadingModels ? (
                  <Skeleton className="h-9 w-full" />
                ) : availableModels.length > 0 ? (
                  <Select value={selectedModel} onValueChange={setSelectedModel}>
                    <SelectTrigger id="session-model" className="w-full">
                      <SelectValue
                        placeholder={
                          availableModels.find((m) => m.isDefault)?.label ?? 'Select model…'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                          {m.isDefault && (
                            <span className="ml-1.5 text-muted-foreground text-xs">(default)</span>
                          )}
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

            {mcpServers.length > 0 && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setMcpExpanded((v) => !v)}
                  className="flex w-full items-center gap-1.5 text-sm font-medium text-foreground/90 hover:text-foreground transition-colors"
                >
                  <ChevronDown
                    className={`size-3.5 text-muted-foreground transition-transform ${mcpExpanded ? '' : '-rotate-90'}`}
                  />
                  <Server className="size-3.5 text-muted-foreground" />
                  MCP Servers
                  {selectedMcpIds.size > 0 && (
                    <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">
                      {selectedMcpIds.size}
                    </Badge>
                  )}
                </button>
                {mcpExpanded && (
                  <div className="rounded-md border border-border/50 bg-muted/20 p-2 space-y-1">
                    <div className="flex items-center justify-between pb-1 mb-1 border-b border-border/30">
                      <span className="text-[11px] text-muted-foreground">
                        {selectedMcpIds.size}/{mcpServers.length} selected
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedMcpIds((prev) =>
                            prev.size === mcpServers.length
                              ? new Set()
                              : new Set(mcpServers.map((s) => s.id)),
                          )
                        }
                        className="text-[11px] text-primary/70 hover:text-primary transition-colors"
                      >
                        {selectedMcpIds.size === mcpServers.length ? 'None' : 'All'}
                      </button>
                    </div>
                    <div className="max-h-[140px] overflow-y-auto space-y-0.5 scrollbar-thin">
                      {mcpServers.map((server) => (
                        <label
                          key={server.id}
                          className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/40 cursor-pointer transition-colors"
                        >
                          <Checkbox
                            checked={selectedMcpIds.has(server.id)}
                            onCheckedChange={(checked) =>
                              setSelectedMcpIds((prev) => {
                                const next = new Set(prev);
                                if (checked) next.add(server.id);
                                else next.delete(server.id);
                                return next;
                              })
                            }
                          />
                          <span className="text-sm truncate flex-1">{server.name}</span>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 font-mono shrink-0"
                          >
                            {server.transportType}
                          </Badge>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {isClaudeAgent && (
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={useWorktree}
                  onCheckedChange={(checked) => setUseWorktree(checked === true)}
                />
                <GitBranch className="size-3.5 text-muted-foreground" />
                <span className="text-sm">Isolated worktree</span>
                <span className="text-xs text-muted-foreground">
                  — agent works in a separate git branch
                </span>
              </label>
            )}

            {isClaudeAgent && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setAdvancedExpanded((v) => !v)}
                  className="flex w-full items-center gap-1.5 text-sm font-medium text-foreground/90 hover:text-foreground transition-colors"
                >
                  {advancedExpanded ? (
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  )}
                  Advanced
                </button>
                {advancedExpanded && (
                  <div className="rounded-md border border-border/50 bg-muted/20 p-3 space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="max-budget-usd" className="text-xs text-muted-foreground">
                        Max budget (USD)
                      </Label>
                      <Input
                        id="max-budget-usd"
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="e.g. 1.00"
                        value={maxBudgetUsd}
                        onChange={(e) => setMaxBudgetUsd(e.target.value)}
                        className="h-8 text-sm"
                      />
                      <p className="text-[11px] text-muted-foreground/60">
                        API key users only. Agent stops when exceeded.
                      </p>
                    </div>
                  </div>
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
                  onChange={(e) => {
                    setPromptText(e.target.value);
                    saveDraft(e.target.value);
                  }}
                  placeholder="Describe what you want the agent to do..."
                  className="min-h-[160px] resize-y"
                />
              )}
              <p className="text-xs text-muted-foreground">
                Pre-filled from the task. Edit freely before starting.
              </p>
            </div>
          </DialogBody>

          <ErrorAlert message={error} className="shrink-0" />

          <DialogFooter>
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
