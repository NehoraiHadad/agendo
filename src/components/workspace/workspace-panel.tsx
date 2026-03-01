'use client';

import { useMemo } from 'react';
import type { PanelStreamState } from '@/hooks/use-multi-session-streams';
import type { SessionStatus } from '@/lib/realtime/events';
import { SessionChatView } from '@/components/sessions/session-chat-view';
import { SessionMessageInput } from '@/components/sessions/session-message-input';
import { WorkspacePanelHeader } from './workspace-panel-header';

interface WorkspacePanelProps {
  sessionId: string;
  sessionTitle?: string | null;
  stream: PanelStreamState;
  needsAttention: boolean;
  isFocused: boolean;
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
  onFocus,
  onExpand,
  onRemove,
  autoGrow = false,
}: WorkspacePanelProps) {
  const adaptedStream = usePanelStreamAdapter(stream);

  const initEvent = stream.events
    .filter((e): e is Extract<typeof e, { type: 'session:init' }> => e.type === 'session:init')
    .at(-1);
  const slashCommands = initEvent?.slashCommands;
  const mcpServers = initEvent?.mcpServers;

  const currentStatus = stream.sessionStatus as SessionStatus | null;

  const borderClass = needsAttention
    ? 'ring-1 ring-amber-500/40 shadow-[0_0_0_1px_oklch(0.78_0.17_65/0.35),0_0_16px_oklch(0.78_0.17_65/0.12)]'
    : isFocused
      ? 'ring-1 ring-sky-500/30 shadow-[0_0_0_1px_oklch(0.68_0.17_220/0.25),0_0_16px_oklch(0.68_0.17_220/0.08)]'
      : 'ring-0';

  return (
    <div
      className={`flex flex-col rounded-xl border border-white/[0.07] bg-[oklch(0.085_0.005_240)] overflow-hidden transition-shadow duration-200 ${borderClass}`}
      style={{ height: '100%' }}
      onClick={onFocus}
      role="region"
      aria-label={`Panel for session ${sessionTitle ?? sessionId.slice(0, 8)}`}
    >
      {/* Panel header — drag handle attached here via panel-drag-handle class */}
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
    </div>
  );
}
