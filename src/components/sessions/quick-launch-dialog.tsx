'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquare, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { Agent } from '@/lib/types';

interface QuickLaunchDialogProps {
  projectId: string;
  open: boolean;
  defaultAgentId?: string;
  onOpenChange: (open: boolean) => void;
}

interface AgentListResponse {
  data: Agent[];
}

export function QuickLaunchDialog({
  projectId,
  open,
  defaultAgentId,
  onOpenChange,
}: QuickLaunchDialogProps) {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(defaultAgentId ?? '');
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [prompt, setPrompt] = useState('');
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void fetch('/api/agents?group=ai')
      .then((r) => r.json())
      .then((json: AgentListResponse) => {
        const activeAgents = json.data.filter((a) => a.isActive);
        setAgents(activeAgents);
        setSelectedAgentId(defaultAgentId ?? activeAgents[0]?.id ?? '');
      });
  }, [open, defaultAgentId]);

  async function handleLaunch() {
    if (!selectedAgentId || isLaunching) return;
    setIsLaunching(true);
    setError(null);
    try {
      const res = await apiFetch<ApiResponse<{ sessionId: string; taskId: string }>>(
        `/api/projects/${projectId}/sessions`,
        {
          method: 'POST',
          body: JSON.stringify({
            agentId: selectedAgentId,
            initialPrompt: prompt.trim() || undefined,
            view,
          }),
        },
      );
      onOpenChange(false);
      router.push(`/sessions/${res.data.sessionId}?tab=${view}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to launch session');
      setIsLaunching(false);
    }
  }

  function getAgentIcon(agent: Agent): string {
    const meta = agent.metadata as { icon?: string } | null;
    return meta?.icon ?? '🤖';
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Launch Agent</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5 pt-2">
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
                  <span className="text-base leading-none">{getAgentIcon(agent)}</span>
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
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What do you want to work on?"
              className="min-h-[80px] resize-none"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

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
        </div>
      </DialogContent>
    </Dialog>
  );
}
