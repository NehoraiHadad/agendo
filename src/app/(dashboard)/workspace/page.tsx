export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { listWorkspaces } from '@/lib/services/workspace-service';
import { PanelTop, Plus, Clock } from 'lucide-react';
import type { AgentWorkspace } from '@/lib/types';
import type { WorkspaceLayout } from '@/lib/types';

function formatDate(date: Date | string | null): string {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(date));
  } catch {
    return '';
  }
}

function WorkspaceCard({ workspace }: { workspace: AgentWorkspace }) {
  const layout = workspace.layout as WorkspaceLayout | null;
  const panelCount = layout?.panels.length ?? 0;
  const gridCols = layout?.gridCols ?? 2;

  return (
    <Link
      href={`/workspace/${workspace.id}`}
      className="group relative flex flex-col gap-4 rounded-xl border border-white/[0.07] bg-[oklch(0.09_0.005_240)] p-4 hover:border-white/[0.14] hover:bg-[oklch(0.10_0.006_240)] transition-all duration-200 overflow-hidden"
    >
      {/* Subtle top accent */}
      <div
        className="absolute top-0 left-0 right-0 h-[1px]"
        style={{
          background: 'linear-gradient(90deg, oklch(0.68 0.17 220 / 0.5) 0%, transparent 60%)',
        }}
      />

      {/* Icon + name */}
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] group-hover:border-sky-500/20 group-hover:bg-sky-500/[0.05] transition-colors">
          <PanelTop className="size-4 text-muted-foreground/50 group-hover:text-sky-400/70 transition-colors" />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-foreground/90 truncate group-hover:text-foreground transition-colors">
            {workspace.name}
          </h3>
          <p className="text-xs text-muted-foreground/45 mt-0.5 font-mono">
            {panelCount} panel{panelCount !== 1 ? 's' : ''} · {gridCols}-column grid
          </p>
        </div>
      </div>

      {/* Panel grid preview — a simple schematic */}
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
        aria-hidden
      >
        {Array.from({ length: Math.max(panelCount, gridCols) }).map((_, i) => (
          <div
            key={i}
            className={`h-6 rounded border ${
              i < panelCount
                ? 'border-sky-500/20 bg-sky-500/[0.06]'
                : 'border-white/[0.04] bg-white/[0.015]'
            }`}
          />
        ))}
      </div>

      {/* Footer metadata */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/35">
        <Clock className="size-3" />
        <span>Updated {formatDate(workspace.updatedAt)}</span>
      </div>
    </Link>
  );
}

function NewWorkspaceCard() {
  return (
    <Link
      href="/workspace/new"
      className="group flex min-h-[160px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.10] bg-white/[0.01] text-muted-foreground/35 hover:border-white/[0.22] hover:text-muted-foreground/60 hover:bg-white/[0.03] transition-all duration-200"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] group-hover:border-white/[0.15] group-hover:bg-white/[0.06] transition-all duration-200">
        <Plus className="size-5" />
      </span>
      <span className="text-xs font-medium tracking-wide">New Workspace</span>
    </Link>
  );
}

export default async function WorkspaceListPage() {
  const workspaces = await listWorkspaces({});

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground/90">Workspaces</h1>
          <p className="text-sm text-muted-foreground/50 mt-1">
            Multi-agent side-by-side session views
          </p>
        </div>
        <Link
          href="/workspace/new"
          className="inline-flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg border border-white/[0.10] bg-white/[0.04] text-foreground/70 hover:bg-white/[0.08] hover:text-foreground/90 hover:border-white/[0.16] transition-colors"
        >
          <Plus className="size-3.5" />
          New workspace
        </Link>
      </div>

      {/* Grid */}
      {workspaces.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NewWorkspaceCard />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <WorkspaceCard key={ws.id} workspace={ws} />
          ))}
          <NewWorkspaceCard />
        </div>
      )}

      {/* Empty state message */}
      {workspaces.length === 0 && (
        <p className="text-center text-sm text-muted-foreground/40 pt-2">
          Create a workspace to monitor multiple agent sessions side by side.
        </p>
      )}
    </div>
  );
}
