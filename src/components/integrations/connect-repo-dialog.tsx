'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Plug, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-types';
import { agentColorKey } from '@/lib/utils/agent-switch-colors';
import { getTeamColor } from '@/lib/utils/team-colors';

interface AgentOption {
  id: string;
  name: string;
}

interface AgentWithCapabilities {
  id: string;
  name: string;
  isActive: boolean;
  capabilities: Array<{ id: string; key: string; isEnabled: boolean }>;
}

interface ConnectRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectRepoDialog({ open, onOpenChange }: ConnectRepoDialogProps) {
  const router = useRouter();
  const [source, setSource] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch('/api/agents?capabilities=true', { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ data: AgentWithCapabilities[] }>) : null))
      .then((body) => {
        if (controller.signal.aborted || !body?.data) return;
        const rows: AgentOption[] = [];
        for (const agent of body.data) {
          if (!agent.isActive) continue;
          const hasCap = agent.capabilities.some((c) => c.key === 'repo-planner' && c.isEnabled);
          if (hasCap) rows.push({ id: agent.id, name: agent.name });
        }
        setAgents(rows);
        if (rows.length > 0) setSelectedAgentId(rows[0].id);
      })
      .catch(() => {
        /* silently ignore fetch errors */
      });
    return () => controller.abort();
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSource('');
      setError('');
      setAgents([]);
      setSelectedAgentId('');
    }
    onOpenChange(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!source.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setError('');
    try {
      const body: Record<string, string> = { source: source.trim() };
      if (selectedAgentId) body.agentId = selectedAgentId;
      const result = await apiFetch<{ data: { sessionId: string } }>('/api/integrations', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onOpenChange(false);
      router.push('/sessions/' + result.data.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start integration');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex items-center justify-center size-7 rounded-md bg-emerald-500/10 shrink-0">
              <Plug className="size-3.5 text-emerald-400" />
            </span>
            Add Integration
          </DialogTitle>
        </DialogHeader>

        {/* What happens */}
        <div className="mx-4 mt-1 px-3 py-2.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-xs text-muted-foreground/70 font-mono leading-relaxed">
          <span className="text-emerald-500/70">→</span> analyze source · classify type
          <br />
          <span className="text-emerald-500/70">→</span> save plan · spawn implementer
          <br />
          <span className="text-emerald-500/70">→</span> commit + push notification
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <DialogBody className="flex flex-col gap-4">
            {agents.length > 1 && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                  Agent
                </Label>
                <div className="flex flex-wrap gap-2">
                  {agents.map((agent) => {
                    const color = getTeamColor(agentColorKey(agent.name));
                    const isSelected = agent.id === selectedAgentId;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => setSelectedAgentId(agent.id)}
                        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                          isSelected
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                            : 'border-white/[0.08] bg-white/[0.02] text-muted-foreground hover:border-white/[0.14] hover:bg-white/[0.05]'
                        }`}
                      >
                        <span className={`size-1.5 rounded-full shrink-0 ${color.pulse}`} />
                        {agent.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label
                htmlFor="int-source"
                className="text-xs text-muted-foreground uppercase tracking-wider"
              >
                What to integrate <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="int-source"
                required
                autoFocus
                rows={3}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder={
                  'https://github.com/owner/tool\nhttps://npmjs.com/package/some-lib\nadd a linear integration with task sync'
                }
                className="font-mono text-sm resize-none"
              />
              <p className="text-[11px] text-muted-foreground/40">
                URL, package name, or a description — the agent figures the rest out.
              </p>
            </div>

            {error && (
              <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md border border-destructive/20">
                {error}
              </p>
            )}
          </DialogBody>

          <DialogFooter className="mt-4">
            <Button
              type="submit"
              disabled={!source.trim() || isSubmitting}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white border-0"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Analyzing…
                </>
              ) : (
                <>
                  <Plug className="size-4 mr-2" />
                  Analyze &amp; Integrate
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
