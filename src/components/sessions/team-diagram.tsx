'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, MessageSquare } from 'lucide-react';
import { getTeamColor } from '@/lib/utils/team-colors';
import type { TeamState, TeamMember } from '@/hooks/use-team-state';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TeamDiagramProps {
  teamState: TeamState;
  events: AgendoEvent[];
  sessionStatus?: SessionStatus | null;
  /** When set, clicking an agent card calls this with the agent name. */
  onSelectAgent?: (name: string) => void;
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

function AgentCard({
  member,
  task,
  messageCount,
  isLead,
  recentActivity,
  onClick,
}: {
  member?: TeamMember;
  task?: { subject: string; status: string } | null;
  messageCount: number;
  isLead: boolean;
  recentActivity: boolean;
  onClick?: () => void;
}) {
  const colors = member ? getTeamColor(member.color) : getTeamColor(undefined);
  const isActive = member ? member.status === 'active' : true;
  const name = member?.name ?? 'team-lead';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-all w-full ${
        isLead
          ? 'border-white/[0.12] bg-[oklch(0.12_0_0)]'
          : `${colors.border} border-l-2 bg-[oklch(0.095_0_0)] hover:bg-[oklch(0.11_0_0)]`
      } ${onClick ? 'cursor-pointer active:scale-[0.98]' : ''}`}
    >
      {/* Activity flash */}
      {recentActivity && (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-blue-400 animate-ping" />
      )}

      {/* Name row */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`size-2 rounded-full shrink-0 ${
            isActive ? `${colors.pulse} animate-pulse` : 'bg-zinc-600'
          }`}
        />
        <span className="font-mono text-xs text-foreground/85 font-medium truncate flex-1 min-w-0">
          {name}
        </span>
        {isLead && (
          <span className="text-[8px] bg-white/[0.07] border border-white/[0.10] rounded px-1.5 py-px text-zinc-400 shrink-0 font-mono uppercase tracking-wider">
            lead
          </span>
        )}
        {messageCount > 0 && (
          <span className="flex items-center gap-0.5 text-[9px] font-mono text-muted-foreground/35 shrink-0">
            <MessageSquare className="size-2.5" />
            {messageCount}
          </span>
        )}
      </div>

      {/* Info row */}
      <div className="flex items-center gap-1.5 min-w-0">
        {member && (
          <span className="text-[10px] text-muted-foreground/30 bg-white/[0.03] border border-white/[0.05] rounded px-1.5 py-px truncate max-w-[100px] shrink-0">
            {member.agentType.replace('general-purpose', 'general').slice(0, 14)}
          </span>
        )}
        {member?.currentActivity && member.currentActivity !== 'idle' && (
          <span className="text-[10px] text-blue-400/50 font-mono truncate min-w-0">
            {member.currentActivity}
          </span>
        )}
        {member?.status === 'idle' && (
          <span className="text-[10px] text-muted-foreground/25 italic">idle</span>
        )}
      </div>

      {/* Tool badges */}
      {member && member.recentTools.length > 0 && (
        <div className="flex items-center gap-0.5 flex-wrap">
          {member.recentTools.slice(0, 4).map((tool) => (
            <span
              key={tool}
              className="text-[8px] font-mono px-1 py-px rounded bg-amber-500/[0.06] border border-amber-500/[0.10] text-amber-400/40"
            >
              {tool.length > 10 ? tool.slice(0, 10) : tool}
            </span>
          ))}
        </div>
      )}

      {/* Current task */}
      {task && (
        <div className="flex items-center gap-1.5 mt-0.5">
          {task.status === 'completed' ? (
            <Check className="size-2.5 text-emerald-400/60 shrink-0" />
          ) : (
            <span className="size-1.5 rounded-full bg-blue-400/60 shrink-0" />
          )}
          <span className="text-[10px] text-muted-foreground/35 truncate">
            {task.subject.length > 40 ? `${task.subject.slice(0, 40)}…` : task.subject}
          </span>
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Subagent chip
// ---------------------------------------------------------------------------

function SubagentChip({
  subagentType,
  description,
  status,
}: {
  subagentType?: string;
  description?: string;
  status: 'running' | 'complete' | 'failed';
}) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 ${
        status === 'running'
          ? 'border-blue-500/20 bg-blue-500/[0.03]'
          : status === 'complete'
            ? 'border-zinc-600/20 bg-zinc-800/20 opacity-50'
            : 'border-red-500/20 bg-red-500/[0.03]'
      }`}
    >
      {status === 'running' ? (
        <Loader2 className="size-3 text-blue-400/60 animate-spin shrink-0" />
      ) : status === 'complete' ? (
        <Check className="size-3 text-emerald-400/60 shrink-0" />
      ) : (
        <span className="text-xs text-red-400 shrink-0">✕</span>
      )}
      <span className="font-mono text-[10px] text-muted-foreground/45 truncate">
        {subagentType ?? 'subagent'}
      </span>
      {description && (
        <span className="text-[9px] text-muted-foreground/25 truncate hidden sm:inline">
          {description.length > 30 ? `${description.slice(0, 30)}…` : description}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component — responsive grid layout
// ---------------------------------------------------------------------------

export function TeamDiagram({ teamState, events, sessionStatus, onSelectAgent }: TeamDiagramProps) {
  const [recentAgents, setRecentAgents] = useState<Set<string>>(new Set());
  const lastMsgCountRef = useRef(0);

  // Track recent message activity → brief flash on agent cards
  useEffect(() => {
    const msgs = events.filter(
      (e): e is Extract<AgendoEvent, { type: 'team:message' }> => e.type === 'team:message',
    );
    if (msgs.length <= lastMsgCountRef.current) return;
    const newMsgs = msgs.slice(lastMsgCountRef.current);
    lastMsgCountRef.current = msgs.length;

    const newAgents = new Set(newMsgs.map((m) => m.fromAgent));
    setRecentAgents((prev) => new Set([...prev, ...newAgents]));
    setTimeout(() => {
      setRecentAgents((prev) => {
        const next = new Set(prev);
        for (const a of newAgents) next.delete(a);
        return next;
      });
    }, 3000);
  }, [events]);

  const teammates = teamState.members;
  const activeSubagents = teamState.subagents.filter((s) => s.status !== 'failed');
  const isEnded = sessionStatus === 'ended';

  if (!teamState.isActive) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-1">
          <div className="text-[11px] text-muted-foreground/20 font-mono">no team active</div>
          <div className="text-[9px] text-muted-foreground/12">waiting for team:config event</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain p-4 sm:p-6 space-y-4">
      {/* Status badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-foreground/70 font-medium">
            {teamState.teamName ?? 'agent team'}
          </span>
          <span className="text-[10px] text-muted-foreground/30 font-mono">
            {teammates.length} agent{teammates.length !== 1 ? 's' : ''}
          </span>
        </div>
        {isEnded ? (
          <span className="inline-flex items-center gap-1 text-[9px] font-mono text-zinc-400/60 bg-zinc-800/40 rounded-full px-2 py-0.5 border border-zinc-600/20">
            <span className="size-1 rounded-full bg-zinc-500" />
            ended
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-400/80 bg-emerald-500/[0.08] rounded-full px-2 py-0.5 border border-emerald-500/15">
            <span className="size-1 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        )}
      </div>

      {/* Lead card — full width */}
      <AgentCard isLead messageCount={0} recentActivity={false} task={null} />

      {/* Connection line */}
      <div className="flex justify-center">
        <div className="w-px h-4 bg-white/[0.08]" />
      </div>

      {/* Teammate grid — responsive: 1 col mobile, 2 col tablet, 3 col desktop */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {teammates.map((member) => {
          const memberTask = teamState.tasks.find(
            (t) => t.owner === member.name && t.status === 'in_progress',
          );
          const msgCount = teamState.messagesByAgent[member.name]?.length ?? 0;

          return (
            <AgentCard
              key={member.agentId}
              member={member}
              isLead={false}
              task={memberTask}
              messageCount={msgCount}
              recentActivity={recentAgents.has(member.name)}
              onClick={onSelectAgent ? () => onSelectAgent(member.name) : undefined}
            />
          );
        })}
      </div>

      {/* Subagents — horizontal scroll strip */}
      {activeSubagents.length > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] text-muted-foreground/25 uppercase tracking-widest font-semibold">
            Subagents · {activeSubagents.length}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {activeSubagents.map((sa) => (
              <SubagentChip
                key={sa.agentId}
                subagentType={sa.subagentType}
                description={sa.description}
                status={sa.status}
              />
            ))}
          </div>
        </div>
      )}

      {/* Task summary */}
      {teamState.tasks.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[9px] text-muted-foreground/25 uppercase tracking-widest font-semibold">
            Tasks
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(['in_progress', 'pending', 'completed'] as const).map((status) => {
              const count = teamState.tasks.filter((t) => t.status === status).length;
              if (count === 0) return null;
              const cfg = {
                in_progress: {
                  label: 'Active',
                  color: 'text-blue-400/70',
                  bg: 'bg-blue-500/[0.06]',
                  border: 'border-blue-500/[0.10]',
                },
                pending: {
                  label: 'Pending',
                  color: 'text-zinc-400/50',
                  bg: 'bg-zinc-500/[0.04]',
                  border: 'border-zinc-600/[0.08]',
                },
                completed: {
                  label: 'Done',
                  color: 'text-emerald-400/60',
                  bg: 'bg-emerald-500/[0.06]',
                  border: 'border-emerald-500/[0.10]',
                },
              }[status];
              return (
                <div
                  key={status}
                  className={`rounded-lg border ${cfg.border} ${cfg.bg} px-3 py-2 text-center`}
                >
                  <div className={`text-lg font-mono font-bold ${cfg.color}`}>{count}</div>
                  <div className="text-[9px] text-muted-foreground/30 font-mono">{cfg.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
