'use client';

import { memo, useCallback } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { useTeamMonitorStore, type AgentLiveState } from '@/stores/team-monitor-store';
import type { TeamMember } from '@/hooks/use-team-state';

export interface LiveAgentCardData {
  member: TeamMember;
  subtaskDone: number;
  subtaskTotal: number;
  onSelectAgent: (agentId: string) => void;
}

// Use a plain Node shape compatible with ReactFlow's internal Node type
export interface LiveAgentNode {
  id: string;
  type: 'liveAgent';
  position: { x: number; y: number };
  data: LiveAgentCardData;
}

type StatusKey = 'active' | 'awaiting_input' | 'idle' | 'ended' | 'null';

interface StatusConfig {
  ledColor: string;
  cardAnimation: string;
  label: string;
  labelClass: string;
  ledAnimation: boolean;
}

const STATUS_CONFIG: Record<StatusKey, StatusConfig> = {
  active: {
    ledColor: '#10B981',
    cardAnimation: 'cardGlowEmerald 2.6s ease-in-out infinite',
    label: 'ACTIVE',
    labelClass: 'text-emerald-400',
    ledAnimation: true,
  },
  awaiting_input: {
    ledColor: '#F59E0B',
    cardAnimation: 'cardGlowAmber 3s ease-in-out infinite',
    label: 'WAITING',
    labelClass: 'text-amber-400',
    ledAnimation: false,
  },
  idle: {
    ledColor: '#52525B',
    cardAnimation: '',
    label: 'IDLE',
    labelClass: 'text-zinc-500',
    ledAnimation: false,
  },
  ended: {
    ledColor: '#3B82F6',
    cardAnimation: '',
    label: 'DONE',
    labelClass: 'text-blue-400',
    ledAnimation: false,
  },
  null: {
    ledColor: '#3F3F46',
    cardAnimation: '',
    label: 'INIT',
    labelClass: 'text-zinc-600',
    ledAnimation: false,
  },
};

function getStatusConfig(status: string | null): StatusConfig {
  const key = (status ?? 'null') as StatusKey;
  return STATUS_CONFIG[key] ?? STATUS_CONFIG['idle'];
}

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '';
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function ContextBar({ used, size }: { used: number | null; size: number | null }) {
  if (!used || !size) return null;
  const pct = Math.min(100, Math.round((used / size) * 100));
  const barColor = pct > 80 ? '#EF4444' : pct > 60 ? '#F59E0B' : '#10B981';
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[8px] text-zinc-600 font-mono">
        <span>CTX</span>
        <span style={{ color: barColor }}>{pct}%</span>
      </div>
      <div className="w-full h-[2px] bg-white/[0.06] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="relative overflow-hidden flex items-center gap-1.5 rounded px-2 py-1 bg-white/[0.02]">
      {/* Scan sweep line */}
      <div
        className="absolute inset-y-0 w-8 bg-gradient-to-r from-transparent via-zinc-400/20 to-transparent"
        style={{ animation: 'scanSweep 2s ease-in-out infinite' }}
      />
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block size-1 rounded-full bg-zinc-400 shrink-0"
          style={{
            animation: 'typingDot 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
      <span className="text-[8px] text-zinc-500 font-mono tracking-widest">THINKING</span>
    </div>
  );
}

function ToolChip({ toolName }: { toolName: string }) {
  const short = toolName
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^Bash$/, 'bash')
    .replace(/^(Read|Write|Edit|Glob|Grep)$/, (m) => m.toLowerCase());
  return (
    <div className="flex items-center gap-1.5 rounded px-2 py-1 bg-amber-500/[0.07] border border-amber-500/20">
      <span
        className="inline-block size-1.5 rounded-full bg-amber-400 shrink-0"
        style={{ animation: 'toolPulse 0.9s ease-in-out infinite' }}
      />
      <span className="text-[8px] text-amber-300/80 font-mono truncate" style={{ maxWidth: 140 }}>
        {short}
      </span>
    </div>
  );
}

function LiveAgentCardInner({ data }: NodeProps) {
  const cardData = data as unknown as LiveAgentCardData;
  const { member, subtaskDone, subtaskTotal, onSelectAgent } = cardData;

  const liveState: AgentLiveState | null = useTeamMonitorStore(
    useCallback((s) => s.agentLiveStates.get(member.agentId) ?? null, [member.agentId]),
  );

  const statusKey = liveState?.status ?? null;
  const statusCfg = getStatusConfig(statusKey);
  const progress = subtaskTotal > 0 ? Math.round((subtaskDone / subtaskTotal) * 100) : 0;

  const model = liveState?.modelFromInit ?? member.model ?? null;
  const elapsed = formatElapsed(liveState?.sessionStartedAt ?? null);
  const isThinking = liveState?.isThinking ?? false;
  const currentToolName = liveState?.currentToolName ?? null;

  const handleClick = useCallback(() => {
    onSelectAgent(member.agentId);
  }, [member.agentId, onSelectAgent]);

  const idleStyle: React.CSSProperties =
    statusKey === 'idle' || statusKey === null
      ? { boxShadow: '0 0 0 1px rgba(63,63,70,0.5)' }
      : statusKey === 'ended'
        ? { boxShadow: '0 0 0 1px rgba(59,130,246,0.35), 0 0 10px rgba(59,130,246,0.1)' }
        : {};

  return (
    <div
      className="relative w-60 rounded-xl cursor-pointer select-none transition-transform duration-200 hover:-translate-y-0.5 hover:brightness-110"
      style={{
        background: 'linear-gradient(160deg, rgba(16,16,30,0.97) 0%, rgba(10,10,18,0.99) 100%)',
        animation: statusCfg.cardAnimation || undefined,
        ...idleStyle,
      }}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      {/* Top edge highlight */}
      <div className="absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.12] to-transparent rounded-full" />

      <Handle
        type="target"
        position={Position.Top}
        className="!bg-zinc-700 !border-zinc-600 !w-1.5 !h-1.5"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-zinc-700 !border-zinc-600 !w-1.5 !h-1.5"
      />

      <div className="p-3 space-y-2.5">
        {/* Header row */}
        <div className="flex items-start gap-2">
          <AgentAvatar
            name={member.name}
            slug={member.agentType}
            size="md"
            pulse={statusKey === 'active'}
          />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-semibold text-white/90 truncate leading-tight">
              {member.name}
            </div>
            {model && (
              <div className="text-[8px] text-zinc-600 font-mono truncate mt-0.5 leading-tight">
                {model.split('-').slice(0, 3).join('-')}
              </div>
            )}
          </div>

          {/* Status LED + label */}
          <div className="flex flex-col items-end gap-0.5 shrink-0 min-w-0">
            <div className="flex items-center gap-1">
              <span
                className="size-1.5 rounded-full shrink-0"
                style={{
                  backgroundColor: statusCfg.ledColor,
                  boxShadow: `0 0 5px ${statusCfg.ledColor}80`,
                  animation: statusCfg.ledAnimation ? 'breathe 2s ease-in-out infinite' : undefined,
                }}
              />
              <span
                className={`text-[8px] font-bold tracking-widest font-mono ${statusCfg.labelClass}`}
              >
                {statusCfg.label}
              </span>
            </div>
            {elapsed && <span className="text-[8px] text-zinc-700 font-mono">{elapsed}</span>}
          </div>
        </div>

        {/* Thinking / tool activity indicator */}
        {(isThinking || currentToolName) && (
          <div className="border-t border-white/[0.04] pt-1.5">
            {currentToolName ? <ToolChip toolName={currentToolName} /> : <ThinkingIndicator />}
          </div>
        )}

        {/* Alert badges */}
        {liveState?.hasApprovalPending && !currentToolName && (
          <div className="text-[8px] text-amber-400 bg-amber-400/[0.07] border border-amber-500/25 rounded px-2 py-1 text-center font-mono tracking-widest">
            ⚠ APPROVAL PENDING
          </div>
        )}
        {liveState?.hasRateLimit && (
          <div className="text-[8px] text-orange-400 bg-orange-400/[0.07] border border-orange-500/25 rounded px-2 py-1 text-center font-mono tracking-widest">
            ⏱ RATE LIMITED
          </div>
        )}

        {/* Footer metrics */}
        <div className="space-y-1.5 pt-0.5">
          {/* Subtask progress */}
          {subtaskTotal > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center justify-between text-[8px] font-mono text-zinc-600">
                <span>TASKS</span>
                <span>
                  {subtaskDone}/{subtaskTotal} · {progress}%
                </span>
              </div>
              <div className="w-full h-[2px] bg-white/[0.05] rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500/60 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Context usage bar */}
          <ContextBar used={liveState?.contextUsed ?? null} size={liveState?.contextSize ?? null} />

          {/* Cost / turns */}
          {liveState && (liveState.totalCostUsd > 0 || liveState.totalTurns > 0) && (
            <div className="flex justify-between text-[8px] text-zinc-700 font-mono border-t border-white/[0.04] pt-1">
              {liveState.totalTurns > 0 && <span>{liveState.totalTurns}T</span>}
              {liveState.totalCostUsd > 0 && <span>${liveState.totalCostUsd.toFixed(3)}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const LiveAgentCard = memo(LiveAgentCardInner);
LiveAgentCard.displayName = 'LiveAgentCard';
