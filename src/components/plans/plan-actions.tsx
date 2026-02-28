'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle, Play, Archive, Loader2, Bot, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { Agent, AgentCapability } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentWithCapabilities extends Agent {
  capabilities: AgentCapability[];
}

interface AgentsApiResponse {
  data: AgentWithCapabilities[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFirstPromptCapability(agent: AgentWithCapabilities): AgentCapability | undefined {
  return agent.capabilities?.find((cap) => cap.interactionMode === 'prompt');
}

// ---------------------------------------------------------------------------
// PlanActions
// ---------------------------------------------------------------------------

interface PlanActionsProps {
  planId: string;
  planStatus: string;
  onArchived?: () => void;
  onToggleConversation?: () => void;
  conversationActive?: boolean;
}

export function PlanActions({
  planId,
  planStatus,
  onArchived,
  onToggleConversation,
  conversationActive,
}: PlanActionsProps) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentWithCapabilities[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);

  // Dialog state
  const [validateOpen, setValidateOpen] = useState(false);
  const [executeOpen, setExecuteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  // Selection state for agent dialogs
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [permissionMode, setPermissionMode] = useState<string>('bypassPermissions');

  // Action states
  const [isValidating, setIsValidating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isArchived = planStatus === 'archived';
  const isExecuting_ = planStatus === 'executing';

  const fetchAgents = useCallback(() => {
    setLoadingAgents(true);
    setError(null);
    let cancelled = false;

    apiFetch<AgentsApiResponse>('/api/agents?capabilities=true&group=ai')
      .then((res) => {
        if (cancelled) return;
        const promptAgents = res.data.filter((a) => findFirstPromptCapability(a));
        setAgents(promptAgents);
        setLoadingAgents(false);
        if (promptAgents.length > 0) {
          setSelectedAgentId(promptAgents[0].id);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load agents');
        setLoadingAgents(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const selectedCapability = selectedAgent ? findFirstPromptCapability(selectedAgent) : undefined;

  async function handleValidate() {
    if (!selectedCapability || isValidating) return;
    setIsValidating(true);
    setError(null);
    try {
      const result = await apiFetch<ApiResponse<{ sessionId: string }>>(
        `/api/plans/${planId}/validate`,
        {
          method: 'POST',
          body: JSON.stringify({
            agentId: selectedAgentId,
            capabilityId: selectedCapability.id,
          }),
        },
      );
      setValidateOpen(false);
      router.push(`/sessions/${result.data.sessionId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Validation failed');
      setIsValidating(false);
    }
  }

  async function handleExecute() {
    if (!selectedCapability || isExecuting) return;
    setIsExecuting(true);
    setError(null);
    try {
      const result = await apiFetch<ApiResponse<{ sessionId: string }>>(
        `/api/plans/${planId}/execute`,
        {
          method: 'POST',
          body: JSON.stringify({
            agentId: selectedAgentId,
            capabilityId: selectedCapability.id,
            permissionMode,
          }),
        },
      );
      setExecuteOpen(false);
      router.push(`/sessions/${result.data.sessionId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Execution failed');
      setIsExecuting(false);
    }
  }

  async function handleArchive() {
    if (isArchiving) return;
    setIsArchiving(true);
    setError(null);
    try {
      await apiFetch(`/api/plans/${planId}`, { method: 'DELETE' });
      setArchiveOpen(false);
      onArchived?.();
      router.push('/plans');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Archive failed');
      setIsArchiving(false);
    }
  }

  return (
    <>
      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        {onToggleConversation && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleConversation}
            disabled={isArchived}
            className={cn(
              'h-7 px-3 text-xs border gap-1.5',
              conversationActive
                ? 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border-amber-500/30 bg-amber-500/10'
                : 'text-amber-500/60 hover:text-amber-400 hover:bg-amber-500/10 border-amber-500/15',
            )}
          >
            <MessageSquare className="size-3" />
            <span className="hidden sm:inline">Chat</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setError(null);
            setValidateOpen(true);
            fetchAgents();
          }}
          disabled={isArchived || isExecuting_}
          className="h-7 px-3 text-xs border gap-1.5 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 border-blue-500/20"
        >
          <CheckCircle className="size-3" />
          <span className="hidden sm:inline">Validate</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setError(null);
            setExecuteOpen(true);
            fetchAgents();
          }}
          disabled={isArchived || isExecuting_}
          className="h-7 px-3 text-xs border gap-1.5 text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 border-violet-500/20"
        >
          <Play className="size-3" />
          <span className="hidden sm:inline">Execute</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setError(null);
            setArchiveOpen(true);
          }}
          disabled={isArchived}
          className="h-7 px-3 text-xs border gap-1.5 text-zinc-400 hover:text-zinc-300 hover:bg-zinc-500/10 border-zinc-500/20"
        >
          <Archive className="size-3" />
          <span className="hidden sm:inline">Archive</span>
        </Button>
      </div>

      {/* Validate dialog */}
      <Dialog
        open={validateOpen}
        onOpenChange={(v) => {
          if (!isValidating) setValidateOpen(v);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Validate Plan</DialogTitle>
            <DialogDescription>
              An agent will review this plan against the current codebase and report any issues.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Agent</label>
              {loadingAgents ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
                  <Loader2 className="size-3 animate-spin" /> Loading agents...
                </div>
              ) : agents.length === 0 ? (
                <p className="text-xs text-muted-foreground/60">
                  No agents with prompt capabilities found.
                </p>
              ) : (
                <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                  <SelectTrigger className="w-full border-white/[0.08] bg-white/[0.04]">
                    <div className="flex items-center gap-2">
                      <Bot className="size-3 text-muted-foreground/50 shrink-0" />
                      <SelectValue placeholder="Select agent" />
                    </div>
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

            {selectedCapability && (
              <p className="text-[11px] text-muted-foreground/50">
                Capability: {selectedCapability.label}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setValidateOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleValidate()}
              disabled={isValidating || !selectedCapability}
              className="gap-1.5 bg-blue-500/15 text-blue-400 border-blue-500/25 hover:bg-blue-500/25"
            >
              {isValidating ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <CheckCircle className="size-3" />
              )}
              Validate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Execute dialog */}
      <Dialog
        open={executeOpen}
        onOpenChange={(v) => {
          if (!isExecuting) setExecuteOpen(v);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Execute Plan</DialogTitle>
            <DialogDescription>
              An agent will execute this plan. The plan content will be used as the initial prompt.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Agent</label>
              {loadingAgents ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
                  <Loader2 className="size-3 animate-spin" /> Loading agents...
                </div>
              ) : agents.length === 0 ? (
                <p className="text-xs text-muted-foreground/60">
                  No agents with prompt capabilities found.
                </p>
              ) : (
                <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                  <SelectTrigger className="w-full border-white/[0.08] bg-white/[0.04]">
                    <div className="flex items-center gap-2">
                      <Bot className="size-3 text-muted-foreground/50 shrink-0" />
                      <SelectValue placeholder="Select agent" />
                    </div>
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

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Permission mode</label>
              <Select value={permissionMode} onValueChange={setPermissionMode}>
                <SelectTrigger className="w-full border-white/[0.08] bg-white/[0.04]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bypassPermissions">Auto (bypass all)</SelectItem>
                  <SelectItem value="acceptEdits">Edit Only</SelectItem>
                  <SelectItem value="default">Approve each</SelectItem>
                  <SelectItem value="plan">Plan mode</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {selectedCapability && (
              <p className="text-[11px] text-muted-foreground/50">
                Capability: {selectedCapability.label}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setExecuteOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleExecute()}
              disabled={isExecuting || !selectedCapability}
              className="gap-1.5 bg-violet-500/15 text-violet-400 border-violet-500/25 hover:bg-violet-500/25"
            >
              {isExecuting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Play className="size-3" />
              )}
              Execute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive confirmation dialog */}
      <Dialog
        open={archiveOpen}
        onOpenChange={(v) => {
          if (!isArchiving) setArchiveOpen(v);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Archive plan?</DialogTitle>
            <DialogDescription>
              The plan will be marked as archived. This cannot be undone from the UI.
            </DialogDescription>
          </DialogHeader>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleArchive()}
              disabled={isArchiving}
              className="gap-1.5"
            >
              {isArchiving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Archive className="size-3" />
              )}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
