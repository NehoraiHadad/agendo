'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { Minimize2, LayoutGrid, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/lib/store/workspace-store';
import { useMultiSessionStreams } from '@/hooks/use-multi-session-streams';
import { WorkspacePanel } from '@/components/workspace/workspace-panel';
import { WorkspaceAddPanel } from '@/components/workspace/workspace-add-panel';
import type { AgentWorkspace } from '@/lib/types';
import type { WorkspaceLayout } from '@/lib/types';

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function useDebounce(fn: () => void, delay: number): () => void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => fn(), delay);
  }, [fn, delay]);
}

// ---------------------------------------------------------------------------
// WorkspaceClient
// ---------------------------------------------------------------------------

interface WorkspaceClientProps {
  workspace: AgentWorkspace;
}

export function WorkspaceClient({ workspace }: WorkspaceClientProps) {
  const layout = workspace.layout as WorkspaceLayout | null;

  // Hydrate the store from the server-fetched workspace
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const removePanel = useWorkspaceStore((s) => s.removePanel);
  const setFocused = useWorkspaceStore((s) => s.setFocused);
  const setExpanded = useWorkspaceStore((s) => s.setExpanded);
  const setNeedsAttention = useWorkspaceStore((s) => s.setNeedsAttention);
  const setPanelStatus = useWorkspaceStore((s) => s.setPanelStatus);
  const setGridCols = useWorkspaceStore((s) => s.setGridCols);
  const setPanelHeight = useWorkspaceStore((s) => s.setPanelHeight);
  const persistLayout = useWorkspaceStore((s) => s.persistLayout);

  const panels = useWorkspaceStore((s) => s.panels);
  const panelHeights = useWorkspaceStore((s) => s.panelHeights);
  const gridCols = useWorkspaceStore((s) => s.gridCols);
  const expandedPanelId = useWorkspaceStore((s) => s.expandedPanelId);
  const focusedPanelId = useWorkspaceStore((s) => s.focusedPanelId);

  // We can't call getSessionIds() reactively, so derive from panels
  const sessionIds = Object.keys(panels);

  // One-time hydration on mount
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    setWorkspace(workspace.id, layout ?? { panels: [], gridCols: 2 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Connect SSE streams for all panels
  const { streams } = useMultiSessionStreams(sessionIds);

  // Sync stream statuses + attention into the store
  useEffect(() => {
    for (const [sessionId, streamState] of streams) {
      if (streamState.sessionStatus) {
        setPanelStatus(sessionId, streamState.sessionStatus);
      }

      // Detect tool-approval events to set needsAttention
      const lastEvent = streamState.events.at(-1);
      if (lastEvent?.type === 'agent:tool-approval') {
        setNeedsAttention(sessionId, true);
      }
    }
  }, [streams, setPanelStatus, setNeedsAttention]);

  // Debounced layout persist (500ms)
  const debouncedPersist = useDebounce(persistLayout, 500);

  // Persist layout whenever panels, gridCols, or panelHeights change (after initial hydration)
  const isFirstRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    debouncedPersist();
  }, [panels, gridCols, panelHeights, debouncedPersist]);

  // Count panels needing attention for the page title
  const attentionCount = Object.values(panels).filter((p) => p.needsAttention).length;

  // Handle removing a panel — also clears attention
  const handleRemovePanel = useCallback(
    (sessionId: string) => {
      removePanel(sessionId);
    },
    [removePanel],
  );

  // Handle focusing a panel — clears attention when focused
  const handleFocusPanel = useCallback(
    (sessionId: string) => {
      setFocused(sessionId);
      setNeedsAttention(sessionId, false);
    },
    [setFocused, setNeedsAttention],
  );

  // Track whether we've fetched session titles
  const [sessionTitles, setSessionTitles] = useState<Record<string, string | null>>({});

  useEffect(() => {
    const missing = sessionIds.filter((id) => !(id in sessionTitles));
    if (missing.length === 0) return;

    for (const sessionId of missing) {
      fetch(`/api/sessions/${sessionId}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ data?: { title?: string | null } }>) : null))
        .then((body) => {
          if (body?.data) {
            setSessionTitles((prev) => ({
              ...prev,
              [sessionId]: body.data?.title ?? null,
            }));
          }
        })
        .catch(() => {});
    }
  }, [sessionIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const panelList = Object.values(panels);

  // Page-level title with attention indicator
  const pageTitle = attentionCount > 0 ? `(${attentionCount}) ${workspace.name}` : workspace.name;

  // Sync page title
  useEffect(() => {
    document.title = `${pageTitle} — Workspace | agenDo`;
  }, [pageTitle]);

  const expandedPanelState = expandedPanelId ? panels[expandedPanelId] : null;
  const expandedStream = expandedPanelId ? streams.get(expandedPanelId) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------------------------------------------ */}
      {/* Workspace toolbar                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Workspace name + attention count */}
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <h1 className="text-base font-semibold text-foreground/90 truncate">{workspace.name}</h1>
          {attentionCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400">
              <AlertCircle className="size-3" />
              {attentionCount} need{attentionCount !== 1 ? 's' : ''} attention
            </span>
          )}
        </div>

        {/* Grid column toggle */}
        <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] p-0.5 shrink-0">
          {([2, 3] as const).map((cols) => (
            <button
              key={cols}
              type="button"
              onClick={() => setGridCols(cols)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                gridCols === cols
                  ? 'bg-white/[0.10] text-foreground/90'
                  : 'text-muted-foreground/40 hover:text-muted-foreground/70'
              }`}
              aria-pressed={gridCols === cols}
              aria-label={`${cols} column grid`}
            >
              <LayoutGrid className="size-3" />
              <span>{cols}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Main grid                                                            */}
      {/* ------------------------------------------------------------------ */}
      {/* Responsive grid: mobile=1col, desktop=dynamic cols.
          Each panel manages its own height via the resize handle. */}
      <style>{`
        @media (min-width: 640px) {
          [data-workspace-grid] {
            grid-template-columns: repeat(${gridCols}, minmax(0, 1fr));
          }
        }
      `}</style>
      <div data-workspace-grid className="grid gap-3 items-start grid-cols-1">
        {/* Session panels */}
        {panelList.map((panel) => {
          const stream = streams.get(panel.sessionId) ?? {
            events: [],
            sessionStatus: null,
            isConnected: false,
            error: null,
          };
          const sessionTitle = sessionTitles[panel.sessionId] ?? null;

          return (
            <WorkspacePanel
              key={panel.sessionId}
              sessionId={panel.sessionId}
              sessionTitle={sessionTitle}
              stream={stream}
              needsAttention={panel.needsAttention}
              isFocused={focusedPanelId === panel.sessionId}
              panelHeight={panelHeights[panel.sessionId]}
              onHeightChange={(h) => setPanelHeight(panel.sessionId, h)}
              onFocus={() => handleFocusPanel(panel.sessionId)}
              onExpand={() => setExpanded(panel.sessionId)}
              onRemove={() => handleRemovePanel(panel.sessionId)}
            />
          );
        })}

        {/* Add panel placeholder (only if under the cap) */}
        {panelList.length < 6 && <WorkspaceAddPanel />}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Expanded panel overlay                                               */}
      {/* ------------------------------------------------------------------ */}
      {expandedPanelId && expandedPanelState && expandedStream && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm">
          {/* Overlay inner panel */}
          <div className="flex flex-col flex-1 m-3 sm:m-6 rounded-2xl border border-white/[0.10] bg-[oklch(0.085_0.005_240)] overflow-hidden shadow-[0_32px_64px_oklch(0_0_0/0.7)]">
            {/* Expanded panel header */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.07] bg-[oklch(0.095_0.005_240)] shrink-0">
              <span className="flex-1 min-w-0 text-sm font-mono text-foreground/80 truncate">
                {sessionTitles[expandedPanelId] ?? `Session ${expandedPanelId.slice(0, 8)}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(null)}
                className="h-7 px-2 text-muted-foreground/50 hover:text-foreground/80"
                aria-label="Collapse panel"
              >
                <Minimize2 className="size-3.5 mr-1" />
                <span className="text-xs">Collapse</span>
              </Button>
            </div>

            {/* Expanded chat view — full, non-compact */}
            <WorkspacePanel
              sessionId={expandedPanelId}
              sessionTitle={sessionTitles[expandedPanelId] ?? null}
              stream={expandedStream}
              needsAttention={expandedPanelState.needsAttention}
              isFocused={true}
              onFocus={() => {}}
              onExpand={() => setExpanded(null)}
              onRemove={() => {
                handleRemovePanel(expandedPanelId);
                setExpanded(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
