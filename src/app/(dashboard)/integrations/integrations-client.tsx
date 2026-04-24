'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Plug, Trash2, Loader2, ExternalLink, Terminal } from 'lucide-react';
import Link from 'next/link';
import { ConnectRepoDialog } from '@/components/integrations/connect-repo-dialog';
import { Button } from '@/components/ui/button';
import { DemoGuard } from '@/components/demo';
import type { Task } from '@/lib/types';

// Pipeline steps — maps task status to which step is active (0-indexed; 4 = all done)
const STEPS = ['Analyze', 'Plan', 'Build', 'Live'] as const;

function getActiveStep(status: string): number {
  if (status === 'done') return 4;
  if (status === 'review') return 2;
  if (status === 'in_progress') return 1;
  return 0;
}

function PipelineTrack({ status }: { status: string }) {
  const active = getActiveStep(status);
  const isComplete = status === 'done';

  return (
    <div className="flex items-start">
      {STEPS.map((label, i) => {
        const done = i < active || isComplete;
        const current = !isComplete && i === active;
        const future = !done && !current;

        return (
          <div key={label} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5">
              <div className="relative size-2 flex items-center justify-center">
                <div
                  className={[
                    'size-2 rounded-full transition-colors duration-500',
                    done ? 'bg-emerald-400' : '',
                    current ? 'bg-emerald-400' : '',
                    future ? 'bg-white/[0.12]' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                />
                {current && (
                  <span className="absolute inset-0 rounded-full bg-emerald-400/50 animate-ping" />
                )}
              </div>
              <span
                className={[
                  'text-[10px] leading-none font-medium select-none',
                  done ? 'text-emerald-400/50' : '',
                  current ? 'text-emerald-300' : '',
                  future ? 'text-white/20' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={[
                  'h-px w-7 mx-1 mb-4 transition-colors duration-500',
                  i < active || isComplete ? 'bg-emerald-400/25' : 'bg-white/[0.06]',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  const min = Math.floor(ms / 60_000);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return 'just now';
}

export function IntegrationsClient({ integrations }: { integrations: Task[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Auto-refresh every 4s while any integration is still running
  useEffect(() => {
    const hasActive = integrations.some((t) => t.status === 'in_progress' || t.status === 'todo');
    if (!hasActive) return;
    const id = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(id);
  }, [integrations, router]);

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
      } else {
        router.refresh();
      }
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Extend Agendo with new capabilities, libraries, and tools.
          </p>
        </div>
        <DemoGuard message="Integrations can't be added in demo — install locally to try.">
          <Button
            onClick={() => setOpen(true)}
            className="bg-emerald-600 hover:bg-emerald-500 text-white border-0 gap-2 w-full sm:w-auto"
          >
            <Plug className="size-4" />
            Add Integration
          </Button>
        </DemoGuard>
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
            const args = (task.inputContext as { args?: Record<string, string> } | null)?.args;
            const integrationName = args?.integrationName ?? task.title;
            const source = args?.source;
            const sessionId = args?.sessionId;
            const sourceUrl = source?.startsWith('http') ? source : undefined;
            const isRemoving = removing === integrationName;
            const isActive = task.status === 'in_progress' || task.status === 'todo';

            return (
              <div
                key={task.id}
                className={[
                  'group flex flex-col gap-3 px-4 py-4 rounded-lg border transition-colors',
                  isActive
                    ? 'border-emerald-500/20 bg-emerald-500/[0.03]'
                    : 'border-white/[0.06] bg-card hover:border-white/[0.10]',
                ].join(' ')}
              >
                {/* Top row: icon + name + actions */}
                <div className="flex items-center gap-3">
                  <div
                    className={[
                      'flex items-center justify-center size-9 rounded-lg shrink-0',
                      isActive ? 'bg-emerald-500/15' : 'bg-emerald-500/10',
                    ].join(' ')}
                  >
                    {isActive ? (
                      <Loader2 className="size-4 text-emerald-400 animate-spin" />
                    ) : (
                      <Plug className="size-4 text-emerald-400" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium">{integrationName}</span>
                      {sourceUrl && (
                        <a
                          href={sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
                          title={source}
                        >
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                    {source && !sourceUrl && (
                      <p className="text-xs text-muted-foreground/40 mt-0.5 truncate">{source}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {sessionId && (
                      <Link
                        href={`/sessions/${sessionId}`}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground/50 hover:text-muted-foreground hover:bg-white/[0.05] transition-colors"
                        title="View agent session"
                      >
                        <Terminal className="size-3" />
                        <span className="hidden sm:inline">Session</span>
                      </Link>
                    )}
                    <DemoGuard message="Integrations can't be removed in demo — install locally to try.">
                      <button
                        type="button"
                        disabled={isRemoving}
                        onClick={() => void handleRemove(integrationName)}
                        className="p-2 rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                      >
                        {isRemoving ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </button>
                    </DemoGuard>
                  </div>
                </div>

                {/* Pipeline track + timestamp */}
                <div className="flex items-end justify-between pl-12">
                  <PipelineTrack status={task.status} />
                  <span className="text-[10px] text-muted-foreground/30 pb-0.5">
                    {timeAgo(task.createdAt)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConnectRepoDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
