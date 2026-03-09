'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plug, Trash2, CheckCircle2, Clock, Loader2, ExternalLink } from 'lucide-react';
import { ConnectRepoDialog } from '@/components/integrations/connect-repo-dialog';
import { Button } from '@/components/ui/button';
import type { Task } from '@/lib/types';

const STATUS_CONFIG: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  done: { icon: CheckCircle2, color: 'text-emerald-400', label: 'Installed' },
  in_progress: { icon: Loader2, color: 'text-blue-400', label: 'Installing…' },
  todo: { icon: Clock, color: 'text-zinc-400', label: 'Pending' },
  review: { icon: Clock, color: 'text-amber-400', label: 'Review' },
};

export function IntegrationsClient({ integrations }: { integrations: Task[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function handleRemove(integrationName: string) {
    if (!confirm(`Remove integration "${integrationName}"? An agent will handle the cleanup.`))
      return;
    setRemoving(integrationName);
    try {
      const res = await fetch(`/api/integrations/${encodeURIComponent(integrationName)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { data?: { sessionId?: string } };
      if (res.ok && json.data?.sessionId) {
        router.push('/sessions/' + json.data.sessionId);
      }
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Extend Agendo with new capabilities, libraries, and tools.
          </p>
        </div>
        <Button
          onClick={() => setOpen(true)}
          className="bg-emerald-600 hover:bg-emerald-500 text-white border-0 gap-2 w-full sm:w-auto"
        >
          <Plug className="size-4" />
          Add Integration
        </Button>
      </div>

      {/* List */}
      {integrations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex items-center justify-center size-14 rounded-2xl bg-emerald-500/10 mb-4">
            <Plug className="size-6 text-emerald-400" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">No integrations yet</p>
          <p className="text-xs text-muted-foreground/50 mt-1">
            Paste a URL, package name, or describe what you want to integrate.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {integrations.map((task) => {
            const integrationName =
              (task.inputContext as { args?: { integrationName?: string } } | null)?.args
                ?.integrationName ?? task.title;
            const source = (task.inputContext as { args?: { source?: string } } | null)?.args
              ?.source;
            const sourceUrl = source && source.startsWith('http') ? source : undefined;
            const statusCfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG['todo'];
            const StatusIcon = statusCfg.icon;
            const isRemoving = removing === integrationName;

            return (
              <div
                key={task.id}
                className="group flex items-center gap-4 px-4 py-3 rounded-lg border border-white/[0.06] bg-card hover:border-white/[0.1] transition-colors"
              >
                <div className="flex items-center justify-center size-9 rounded-lg bg-emerald-500/10 shrink-0">
                  <Plug className="size-4 text-emerald-400" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{integrationName}</span>
                    {sourceUrl && (
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground/30 hover:text-muted-foreground transition-colors"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  <div className={`flex items-center gap-1 mt-0.5 text-xs ${statusCfg.color}`}>
                    <StatusIcon
                      className={`size-3 ${task.status === 'in_progress' ? 'animate-spin' : ''}`}
                    />
                    {statusCfg.label}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={isRemoving}
                  onClick={() => void handleRemove(integrationName)}
                  className="p-2.5 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity min-h-[44px] min-w-[44px] flex items-center justify-center sm:min-h-0 sm:min-w-0"
                >
                  {isRemoving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <ConnectRepoDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
