'use client';

import { useState, useEffect } from 'react';
import { useDraft } from '@/hooks/use-draft';
import { useRouter } from 'next/navigation';
import { useFormSubmit } from '@/hooks/use-form-submit';
import { ChevronDown, GitBranch, Loader2, MessageSquare, Server, Terminal } from 'lucide-react';
import { getAgentIcon } from '@/lib/utils/agent-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorAlert } from '@/components/ui/error-alert';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { Agent, McpServer } from '@/lib/types';
import { DelegationPolicySelect } from '@/components/sessions/delegation-policy-select';
import type { DelegationPolicy } from '@/lib/utils/session-controls';

interface QuickLaunchDialogProps {
  projectId: string;
  open: boolean;
  defaultAgentId?: string;
  defaultKind?: 'conversation' | 'execution';
  onOpenChange: (open: boolean) => void;
}

interface AgentListResponse {
  data: Agent[];
}

export function QuickLaunchDialog({
  projectId,
  open,
  defaultAgentId,
  defaultKind = 'conversation',
  onOpenChange,
}: QuickLaunchDialogProps) {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(defaultAgentId ?? '');
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [prompt, setPrompt] = useState('');
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set());
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [delegationPolicy, setDelegationPolicy] = useState<DelegationPolicy>('suggest');

  const { saveDraft, getDraft, clearDraft } = useDraft(`draft:quick-launch:${projectId}`);

  const {
    isSubmitting: isLaunching,
    error,
    handleSubmit: submitLaunch,
  } = useFormSubmit(async () => {
    const res = await apiFetch<ApiResponse<{ sessionId: string; taskId?: string }>>(
      `/api/projects/${projectId}/sessions`,
      {
        method: 'POST',
        body: JSON.stringify({
          agentId: selectedAgentId,
          initialPrompt: prompt.trim() || undefined,
          view,
          kind: defaultKind,
          mcpServerIds: selectedMcpIds.size > 0 ? [...selectedMcpIds] : undefined,
          useWorktree: useWorktree || undefined,
          delegationPolicy,
        }),
      },
    );
    clearDraft();
    onOpenChange(false);
    router.push(`/sessions/${res.data.sessionId}?tab=${view}`);
  });

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;

    void fetch('/api/agents?group=ai', { signal })
      .then((r) => r.json())
      .then((json: AgentListResponse) => {
        if (!signal.aborted) {
          const activeAgents = json.data.filter((a) => a.isActive);
          setAgents(activeAgents);
          setSelectedAgentId(defaultAgentId ?? activeAgents[0]?.id ?? '');
        }
      });

    // Fetch enabled MCP servers + project overrides to compute defaults
    void Promise.all([
      fetch('/api/mcp-servers?enabled=true', { signal }).then((r) =>
        r.ok ? (r.json() as Promise<McpServer[]>) : [],
      ),
      fetch(`/api/projects/${projectId}/mcp-servers`, { signal }).then((r) =>
        r.ok ? (r.json() as Promise<{ mcpServerId: string; enabled: boolean }[]>) : [],
      ),
    ])
      .then(([servers, overrides]) => {
        if (signal.aborted) return;
        setMcpServers(servers);
        // Start with global defaults, then apply project overrides
        const defaults = new Set(servers.filter((s) => s.isDefault).map((s) => s.id));
        for (const o of overrides) {
          if (o.enabled) defaults.add(o.mcpServerId);
          else defaults.delete(o.mcpServerId);
        }
        setSelectedMcpIds(defaults);
      })
      .catch(() => {});

    return () => controller.abort();
  }, [open, defaultAgentId, projectId]);

  async function handleLaunch() {
    if (!selectedAgentId || isLaunching) return;
    await submitLaunch();
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      // Reset MCP state when opening
      setSelectedMcpIds(new Set());
      setMcpExpanded(false);
      // Restore draft (if prompt is still empty — fresh page load)
      if (!prompt) {
        const saved = getDraft();
        if (saved) setPrompt(saved);
      }
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {defaultKind === 'conversation' ? 'New Conversation' : 'Launch Agent'}
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-5">
          {/* Agent picker */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Agent</Label>
            <div className="flex gap-2 flex-wrap">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedAgentId(agent.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    selectedAgentId === agent.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-white/[0.08] bg-card hover:border-white/[0.16] text-foreground'
                  }`}
                >
                  {getAgentIcon(agent)}
                  {agent.name}
                </button>
              ))}
              {agents.length === 0 && (
                <p className="text-sm text-muted-foreground">Loading agents…</p>
              )}
            </div>
          </div>

          {/* View selector */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">View</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setView('chat')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  view === 'chat'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-white/[0.08] bg-card hover:border-white/[0.16] text-foreground'
                }`}
              >
                <MessageSquare className="size-4" />
                Chat
              </button>
              <button
                type="button"
                onClick={() => setView('terminal')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  view === 'terminal'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-white/[0.08] bg-card hover:border-white/[0.16] text-foreground'
                }`}
              >
                <Terminal className="size-4" />
                Terminal
              </button>
            </div>
          </div>

          {/* Team delegation policy */}
          <DelegationPolicySelect
            value={delegationPolicy}
            onValueChange={setDelegationPolicy}
            variant="compact"
          />

          {/* MCP server picker */}
          {mcpServers.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setMcpExpanded((v) => !v)}
                className="flex w-full items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
              >
                <ChevronDown
                  className={`size-3.5 transition-transform ${mcpExpanded ? '' : '-rotate-90'}`}
                />
                <Server className="size-3.5" />
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

          {/* Worktree toggle — only for Claude */}
          {(() => {
            const selectedAgent = agents.find((a) => a.id === selectedAgentId);
            const isClaude = selectedAgent?.binaryPath?.toLowerCase().includes('claude');
            if (!isClaude) return null;
            return (
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
            );
          })()}

          {/* Initial prompt */}
          <div className="space-y-2">
            <Label
              htmlFor="ql-prompt"
              className="text-xs text-muted-foreground uppercase tracking-wider"
            >
              Initial Prompt <span className="font-normal normal-case">(optional)</span>
            </Label>
            <Textarea
              id="ql-prompt"
              dir="auto"
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                saveDraft(e.target.value);
              }}
              placeholder="What do you want to work on?"
              className="min-h-[80px] resize-none"
            />
          </div>
        </DialogBody>

        <ErrorAlert message={error} />

        <Button
          onClick={() => void handleLaunch()}
          disabled={!selectedAgentId || isLaunching}
          className="w-full"
        >
          {isLaunching ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />
              Launching…
            </>
          ) : (
            'Launch →'
          )}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
