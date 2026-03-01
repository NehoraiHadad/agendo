'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { Minimize2, LayoutGrid, AlertCircle } from 'lucide-react';
import { GridLayout, useContainerWidth } from 'react-grid-layout';
import type { LayoutItem } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/lib/store/workspace-store';
import { useMultiSessionStreams } from '@/hooks/use-multi-session-streams';
import { WorkspacePanel } from '@/components/workspace/workspace-panel';
import { WorkspaceAddPanel } from '@/components/workspace/workspace-add-panel';
import type { AgentWorkspace } from '@/lib/types';
import type { WorkspaceLayout } from '@/lib/types';

/** Height of one RGL row unit in pixels — must match workspace-store.ts */
const ROW_HEIGHT = 100;

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
  const setRglLayout = useWorkspaceStore((s) => s.setRglLayout);
  const persistLayout = useWorkspaceStore((s) => s.persistLayout);

  const panels = useWorkspaceStore((s) => s.panels);
  const rglLayout = useWorkspaceStore((s) => s.rglLayout);
  const gridCols = useWorkspaceStore((s) => s.gridCols);
  const expandedPanelId = useWorkspaceStore((s) => s.expandedPanelId);
  const focusedPanelId = useWorkspaceStore((s) => s.focusedPanelId);

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
      const lastEvent = streamState.events.at(-1);
      if (lastEvent?.type === 'agent:tool-approval') {
        setNeedsAttention(sessionId, true);
      }
    }
  }, [streams, setPanelStatus, setNeedsAttention]);

  // Track whether a persist is pending (debounce hasn't fired yet)
  const hasPendingPersist = useRef(false);

  // Debounced layout persist (500ms)
  const persistAndClear = useCallback(() => {
    hasPendingPersist.current = false;
    persistLayout();
  }, [persistLayout]);
  const debouncedPersist = useDebounce(persistAndClear, 500);

  // Persist layout whenever panels, gridCols, or rglLayout changes (after initial hydration)
  const isFirstRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    hasPendingPersist.current = true;
    debouncedPersist();
  }, [panels, gridCols, rglLayout, debouncedPersist]);

  // Flush pending persist on page close/refresh or tab background (mobile)
  useEffect(() => {
    const flush = () => {
      if (hasPendingPersist.current) {
        hasPendingPersist.current = false;
        persistLayout();
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [persistLayout]);

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

  // Track session titles
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

  const pageTitle = attentionCount > 0 ? `(${attentionCount}) ${workspace.name}` : workspace.name;

  useEffect(() => {
    document.title = `${pageTitle} — Workspace | agenDo`;
  }, [pageTitle]);

  const expandedPanelState = expandedPanelId ? panels[expandedPanelId] : null;
  const expandedStream = expandedPanelId ? streams.get(expandedPanelId) : null;

  // Measure container width for react-grid-layout
  const { width: containerWidth, mounted, containerRef } = useContainerWidth();

  // On mobile (< 640px), use a single column with no dragging
  const isMobile = containerWidth > 0 && containerWidth < 640;
  const effectiveCols = isMobile ? 1 : gridCols;

  // Handle RGL layout changes — sync into store (triggers debounced persist)
  const handleLayoutChange = useCallback(
    (newLayout: LayoutItem[]) => {
      setRglLayout(newLayout);
    },
    [setRglLayout],
  );

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

        {/* Grid column toggle (desktop only) */}
        {!isMobile && (
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
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Main grid — react-grid-layout                                        */}
      {/* ------------------------------------------------------------------ */}
      <div ref={containerRef}>
        {mounted && (
          <GridLayout
            width={containerWidth}
            layout={rglLayout}
            gridConfig={{
              cols: effectiveCols,
              rowHeight: ROW_HEIGHT,
              margin: [12, 12],
              containerPadding: [0, 0],
            }}
            dragConfig={{
              enabled: !isMobile,
              handle: '.panel-drag-handle',
              cancel: 'button, input, textarea, [role="button"]',
            }}
            resizeConfig={{
              enabled: !isMobile,
              handles: ['se', 's', 'e'],
            }}
            onLayoutChange={handleLayoutChange}
            autoSize
          >
            {panelList.map((panel) => {
              const stream = streams.get(panel.sessionId) ?? {
                events: [],
                sessionStatus: null,
                isConnected: false,
                error: null,
              };
              const sessionTitle = sessionTitles[panel.sessionId] ?? null;

              return (
                <div key={panel.sessionId}>
                  <WorkspacePanel
                    sessionId={panel.sessionId}
                    sessionTitle={sessionTitle}
                    stream={stream}
                    needsAttention={panel.needsAttention}
                    isFocused={focusedPanelId === panel.sessionId}
                    onFocus={() => handleFocusPanel(panel.sessionId)}
                    onExpand={() => setExpanded(panel.sessionId)}
                    onRemove={() => handleRemovePanel(panel.sessionId)}
                  />
                </div>
              );
            })}
          </GridLayout>
        )}
      </div>

      {/* Add panel button — outside GridLayout so it doesn't interfere with drag */}
      {panelList.length < 6 && <WorkspaceAddPanel />}

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

            {/* Expanded chat view — flex-1 so it fills the remaining overlay height */}
            <div className="flex-1 min-h-0">
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
        </div>
      )}
    </div>
  );
}
