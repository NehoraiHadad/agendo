'use client';

import { useState, useEffect } from 'react';
import { Plus, Loader2, MessageSquare } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/lib/store/workspace-store';
import type { Session } from '@/lib/types';

interface SessionOption {
  id: string;
  title: string | null;
  status: string;
}

async function fetchSessionsByStatus(status: string): Promise<SessionOption[]> {
  try {
    const res = await fetch(`/api/sessions?status=${encodeURIComponent(status)}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Session[] };
    return (body.data ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
    }));
  } catch {
    return [];
  }
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  awaiting_input: 'Awaiting input',
  idle: 'Idle',
};

export function WorkspaceAddPanel() {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const addPanel = useWorkspaceStore((s) => s.addPanel);
  const existingSessionIds = useWorkspaceStore((s) => s.getSessionIds());

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    // All state updates live inside the .then() callback (not synchronously in
    // the effect body) to satisfy react-hooks/set-state-in-effect.
    Promise.all([fetchSessionsByStatus('active'), fetchSessionsByStatus('idle')]).then(
      ([active, idle]) => {
        if (cancelled) return;

        // Merge and deduplicate; filter out sessions already in the workspace
        const seen = new Set<string>(existingSessionIds);
        const merged: SessionOption[] = [];
        for (const s of [...active, ...idle]) {
          if (!seen.has(s.id)) {
            seen.add(s.id);
            merged.push(s);
          }
        }
        setSessions(merged);
        setIsLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSelect(sessionId: string) {
    addPanel(sessionId);
    setOpen(false);
  }

  return (
    <>
      {/* Add panel card — dashed border placeholder */}
      <button
        type="button"
        onClick={() => {
          setSessions([]);
          setIsLoading(true);
          setOpen(true);
        }}
        className="group flex min-h-[300px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.12] bg-white/[0.01] text-muted-foreground/30 hover:border-white/[0.22] hover:text-muted-foreground/60 hover:bg-white/[0.03] active:scale-[0.99] transition-all duration-200"
        aria-label="Add a session panel"
      >
        {/* Icon container with subtle glow on hover */}
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] group-hover:border-white/[0.15] group-hover:bg-white/[0.06] transition-all duration-200">
          <Plus className="size-5" />
        </span>
        <span className="text-xs font-medium tracking-wide">Add Session</span>
      </button>

      {/* Session picker dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Session Panel</DialogTitle>
          </DialogHeader>

          <p className="text-sm text-muted-foreground/70">
            Select an active or idle session to add to this workspace.
          </p>

          <div className="mt-2 space-y-1 max-h-64 overflow-y-auto">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-4 animate-spin text-muted-foreground/50" />
              </div>
            )}

            {!isLoading && sessions.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <MessageSquare className="size-6 text-muted-foreground/25" />
                <p className="text-sm text-muted-foreground/50">No available sessions to add.</p>
                <p className="text-xs text-muted-foreground/35">
                  All active and idle sessions are already in this workspace, or none exist.
                </p>
              </div>
            )}

            {!isLoading &&
              sessions.map((session) => {
                const statusLabel = STATUS_LABELS[session.status] ?? session.status;
                const isActive = session.status === 'active' || session.status === 'awaiting_input';

                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleSelect(session.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/[0.12] text-left transition-colors"
                  >
                    {/* Status dot */}
                    <span
                      className={`shrink-0 size-1.5 rounded-full ${
                        isActive ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'
                      }`}
                    />

                    {/* Session info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono text-foreground/80 truncate">
                        {session.title ?? `Session ${session.id.slice(0, 8)}`}
                      </p>
                      <p className="text-[11px] text-muted-foreground/45 mt-0.5">
                        {statusLabel} · {session.id.slice(0, 12)}…
                      </p>
                    </div>

                    {/* Add indicator */}
                    <Plus className="shrink-0 size-3.5 text-muted-foreground/30" />
                  </button>
                );
              })}
          </div>

          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
