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

  const fetchAgents = useCallback(async () => {
    if (agentIdProp) return;
    setIsLoadingAgents(true);
    try {
      const res = await apiFetch<ApiListResponse<Agent>>('/api/agents?pageSize=50');
      setAgents(res.data.filter((a) => a.isActive));
    } catch {
      // ignore
    } finally {
      setIsLoadingAgents(false);
    }
  }, [agentIdProp]);

  const fetchCapabilities = useCallback(async () => {
    if (!activeAgentId) return;
    setIsLoadingCaps(true);
    try {
      const res = await apiFetch<ApiResponse<AgentCapability[]>>(
        `/api/agents/${activeAgentId}/capabilities`,
      );
      const promptCaps = res.data.filter((c) => c.isEnabled && c.interactionMode === 'prompt');
      if (promptCaps.length > 0) {
        setPromptCapId(promptCaps[0].id);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingCaps(false);
    }
  }, [activeAgentId]);

  const fetchTask = useCallback(async () => {
    setIsLoadingTask(true);
    try {
      const res = await apiFetch<ApiResponse<Task>>(`/api/tasks/${taskId}`);
      const task = res.data;
      const lines: string[] = [];
      if (task.title) lines.push(task.title);
      if (task.description) lines.push('', task.description);
      setPromptText(lines.join('\n'));
    } catch {
      // ignore — prompt stays empty
    } finally {
      setIsLoadingTask(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (open) {
      setSelectedAgentId(agentIdProp ?? '');
      setPromptCapId('');
      setPromptText('');
      setError(null);
      fetchAgents();
      fetchTask();
    }
  }, [open, agentIdProp, fetchAgents, fetchTask]);

  useEffect(() => {
    if (open && activeAgentId) {
      setPromptCapId('');
      fetchCapabilities();
    }
  }, [open, activeAgentId, fetchCapabilities]);

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
