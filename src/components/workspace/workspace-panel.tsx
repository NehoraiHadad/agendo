'use client';

import { useMemo, useState, useCallback, useRef } from 'react';
import { GripHorizontal } from 'lucide-react';
import type { PanelStreamState } from '@/hooks/use-multi-session-streams';
import type { SessionStatus } from '@/lib/realtime/events';
import { SessionChatView } from '@/components/sessions/session-chat-view';
import { SessionMessageInput } from '@/components/sessions/session-message-input';
import { WorkspacePanelHeader } from './workspace-panel-header';

const MIN_PANEL_HEIGHT = 280;
const MAX_PANEL_HEIGHT = 2000;

function getDefaultHeight() {
  if (typeof window === 'undefined') return 520;
  return Math.max(MIN_PANEL_HEIGHT, Math.round(window.innerHeight * 0.72));
}

function clamp(v: number) {
  return Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, v));
}

interface WorkspacePanelProps {
  sessionId: string;
  sessionTitle?: string | null;
  stream: PanelStreamState;
  needsAttention: boolean;
  isFocused: boolean;
  /** Server-persisted panel height (undefined = use default). */
  panelHeight?: number;
  /** Called when the user finishes resizing. Pass null to reset to default. */
  onHeightChange?: (height: number | null) => void;
  onFocus: () => void;
  onExpand: () => void;
  onRemove: () => void;
  /** When true, panel grows with conversation content instead of fixed height */
  autoGrow?: boolean;
}

/**
 * Adapts PanelStreamState (from useMultiSessionStreams) to the shape expected
 * by SessionChatView (UseSessionStreamReturn). The two types are structurally
 * similar; this thin wrapper bridges the small interface difference.
 */
function usePanelStreamAdapter(stream: PanelStreamState) {
  return useMemo(
    () => ({
      events: stream.events,
      sessionStatus: stream.sessionStatus,
      isConnected: stream.isConnected,
      error: stream.error,
      reset: () => {
        // no-op — the multi-session hook handles reconnects internally
      },
    }),
    [stream.events, stream.sessionStatus, stream.isConnected, stream.error],
  );
}

export function WorkspacePanel({
  sessionId,
  sessionTitle,
  stream,
  needsAttention,
  isFocused,
  panelHeight,
  onHeightChange,
  onFocus,
  onExpand,
  onRemove,
  autoGrow = false,
}: WorkspacePanelProps) {
  const adaptedStream = usePanelStreamAdapter(stream);

  // ---------------------------------------------------------------------------
  // Resizable height
  // ---------------------------------------------------------------------------
  // Live height during drag (local state); committed height comes from props.
  const resolvedHeight = panelHeight ?? getDefaultHeight();
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging.current = true;
      startY.current = e.clientY;
      startH.current = resolvedHeight;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [resolvedHeight],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const delta = e.clientY - startY.current;
    setLiveHeight(clamp(startH.current + delta));
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const delta = e.clientY - startY.current;
      const final = clamp(startH.current + delta);
      setLiveHeight(null);
      onHeightChange?.(final);
    },
    [onHeightChange],
  );

  // Double-click reset to default
  const onDoubleClick = useCallback(() => {
    setLiveHeight(null);
    onHeightChange?.(null);
  }, [onHeightChange]);

  const displayHeight = liveHeight ?? resolvedHeight;

  // Extract slash commands and MCP servers from the stream for the input
  const initEvent = stream.events
    .filter((e): e is Extract<typeof e, { type: 'session:init' }> => e.type === 'session:init')
    .at(-1);
  const slashCommands = initEvent?.slashCommands;
  const mcpServers = initEvent?.mcpServers;

  const currentStatus = stream.sessionStatus as SessionStatus | null;

  // Compute the border glow class for focus/attention states
  const borderClass = needsAttention
    ? 'ring-1 ring-amber-500/40 shadow-[0_0_0_1px_oklch(0.78_0.17_65/0.35),0_0_16px_oklch(0.78_0.17_65/0.12)]'
    : isFocused
      ? 'ring-1 ring-sky-500/30 shadow-[0_0_0_1px_oklch(0.68_0.17_220/0.25),0_0_16px_oklch(0.68_0.17_220/0.08)]'
      : 'ring-0';

  return (
    <div
      className={`flex flex-col rounded-xl border border-white/[0.07] bg-[oklch(0.085_0.005_240)] overflow-hidden transition-shadow duration-200 ${borderClass}`}
      style={autoGrow ? undefined : { height: displayHeight }}
      onClick={onFocus}
      role="region"
      aria-label={`Panel for session ${sessionTitle ?? sessionId.slice(0, 8)}`}
    >
      {/* Panel header */}
      <WorkspacePanelHeader
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        status={currentStatus}
        needsAttention={needsAttention}
        onExpand={onExpand}
        onRemove={onRemove}
      />

      {/* Panel body — compact chat view */}
      <div className="flex-1 min-h-0 flex flex-col">
        <SessionChatView
          sessionId={sessionId}
          stream={adaptedStream}
          currentStatus={currentStatus}
          compact={true}
          autoGrow={autoGrow}
        />
      </div>

      {/* Panel footer — message input */}
      <SessionMessageInput
        sessionId={sessionId}
        status={currentStatus}
        slashCommands={slashCommands}
        mcpServers={mcpServers}
      />

      {/* Resize handle — only in grid view (not autoGrow) */}
      {!autoGrow && (
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          className="group shrink-0 flex items-center justify-center h-2.5 cursor-row-resize select-none border-t border-white/[0.04] bg-gradient-to-b from-white/[0.02] to-transparent hover:from-white/[0.06] hover:border-white/[0.10] active:from-primary/10 active:border-primary/25 transition-colors touch-none"
          aria-label="Resize panel height"
          title="Drag to resize — double-click to reset"
        >
          <GripHorizontal className="size-3 text-muted-foreground/20 group-hover:text-muted-foreground/50 group-active:text-primary/50 transition-colors" />
        </div>
      )}
    </div>
  );
}
