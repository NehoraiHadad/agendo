'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Square, Clock, CheckSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MobileAgentCard } from '@/components/teams/mobile-agent-card';
import { useTeamMonitorStore } from '@/stores/team-monitor-store';
import {
  useTimelineStore,
  type TimelineEvent,
  type TimelineEventType,
} from '@/stores/timeline-store';
import type { TeamMember, TeamTask } from '@/hooks/use-team-state';
import type { MemberWithSession } from '@/hooks/use-team-canvas-stream';
import type { ServerTeamMember } from '@/components/teams/team-monitor-canvas';
import { apiFetch } from '@/lib/api-types';
import { toast } from 'sonner';

// ── Elapsed timer ─────────────────────────────────────────────────────────────

function ElapsedTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!startedAt) return <span className="text-zinc-600">—</span>;
  const secs = Math.floor((now - startedAt) / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0)
    return (
      <span>
        {hrs}h {mins % 60}m
      </span>
    );
  if (mins > 0)
    return (
      <span>
        {mins}m {secs % 60}s
      </span>
    );
  return <span>{secs}s</span>;
}

// ── Vertical timeline ─────────────────────────────────────────────────────────

const EVENT_COLOR: Record<TimelineEventType, string> = {
  tool_call: '#a855f7',
  message: '#3b82f6',
  task_complete: '#22c55e',
  error: '#ef4444',
  awaiting_input: '#eab308',
  status_change: '#6b7280',
};

const EVENT_LABEL: Record<TimelineEventType, string> = {
  tool_call: 'Tool',
  message: 'Msg',
  task_complete: 'Done',
  error: 'Error',
  awaiting_input: 'Wait',
  status_change: 'Status',
};

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function VerticalTimelineEntry({ event }: { event: TimelineEvent }) {
  const color = EVENT_COLOR[event.type];
  const label = EVENT_LABEL[event.type];

  return (
    <div className="flex items-start gap-3 group">
      {/* Dot + line */}
      <div className="flex flex-col items-center shrink-0 mt-1">
        <span
          className="size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="w-px flex-1 bg-white/[0.06] min-h-[20px] mt-0.5" aria-hidden="true" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-mono font-medium" style={{ color }}>
            {event.agentName}
          </span>
          <span
            className="text-[9px] font-mono uppercase tracking-wide px-1 py-px rounded"
            style={{
              color,
              backgroundColor: `${color}22`,
              border: `1px solid ${color}44`,
            }}
          >
            {label}
          </span>
          <span className="text-[10px] text-zinc-600 font-mono ml-auto">
            {timeAgo(event.timestamp)}
          </span>
        </div>
        <p className="text-[11px] text-zinc-400 mt-0.5 leading-snug line-clamp-2">
          {event.summary}
        </p>
      </div>
    </div>
  );
}

function VerticalTimeline({ className = '' }: { className?: string }) {
  const events = useTimelineStore((s) => s.events);
  const recent = useMemo(() => events.slice(-30).reverse(), [events]);

  if (recent.length === 0) {
    return (
      <div className={`rounded-xl border border-white/10 bg-white/5 backdrop-blur ${className}`}>
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
            Timeline
          </span>
        </div>
        <div className="flex items-center justify-center py-8 text-xs text-zinc-600">
          Waiting for events…
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-white/10 bg-white/5 backdrop-blur ${className}`}>
      <div className="px-4 py-3 border-b border-white/[0.06]">
        <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
          Timeline
        </span>
        <span className="text-[10px] text-zinc-600 font-mono ml-2">({events.length} events)</span>
      </div>
      <ScrollArea className="max-h-80">
        <div className="px-4 pt-3 pb-1" role="log" aria-label="Recent team activity">
          {recent.map((ev) => (
            <VerticalTimelineEntry key={ev.id} event={ev} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Bottom action bar ─────────────────────────────────────────────────────────

interface ActionBarProps {
  teamName: string | null;
  tasks: TeamTask[];
  teamStartedAt: number | null;
  memberSessions: MemberWithSession[];
}

function BottomActionBar({ teamName, tasks, teamStartedAt, memberSessions }: ActionBarProps) {
  const [isStopping, setIsStopping] = useState(false);
  const doneTasks = tasks.filter((t) => t.status === 'completed').length;

  const handleStopAll = useCallback(async () => {
    setIsStopping(true);
    try {
      const results = await Promise.allSettled(
        memberSessions
          .filter((ms) => ms.sessionId !== null)
          .map((ms) =>
            apiFetch<unknown>(`/api/sessions/${ms.sessionId}/cancel`, {
              method: 'POST',
            }),
          ),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        toast.error(`Stopped ${results.length - failed} sessions, ${failed} failed`);
      } else {
        toast.success('All sessions stopped');
      }
    } finally {
      setIsStopping(false);
    }
  }, [memberSessions]);

  return (
    <div
      className="shrink-0 flex items-center gap-3 px-4 py-3 border-t border-white/[0.06] bg-[rgba(10,10,20,0.95)] backdrop-blur-sm"
      role="toolbar"
      aria-label="Team controls"
    >
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-mono">
          <Clock className="size-3 shrink-0" aria-hidden="true" />
          <ElapsedTimer startedAt={teamStartedAt} />
          {tasks.length > 0 && (
            <>
              <span className="text-zinc-700 mx-0.5">·</span>
              <CheckSquare className="size-3 shrink-0" aria-hidden="true" />
              <span>
                {doneTasks}/{tasks.length} tasks
              </span>
            </>
          )}
        </div>
        {teamName && <div className="text-[11px] text-zinc-600 font-mono truncate">{teamName}</div>}
      </div>

      <Button
        size="sm"
        variant="destructive"
        className="h-11 px-4 text-sm shrink-0 min-w-[88px]"
        disabled={isStopping}
        onClick={() => void handleStopAll()}
        aria-label="Stop all agent sessions"
      >
        <Square className="size-4 mr-1.5" aria-hidden="true" />
        {isStopping ? 'Stopping…' : 'Stop All'}
      </Button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface MobileTeamViewProps {
  /** SSE-derived members (rich, live data). Empty until team:config arrives. */
  members: TeamMember[];
  /** Server-fetched members — shown immediately while SSE catches up. */
  serverMembers?: ServerTeamMember[];
  tasks: TeamTask[];
  teamName: string | null;
  memberSessions: MemberWithSession[];
  /** True when at least one team member is known (server or SSE). */
  isActive: boolean;
  sessionStatus: string | null;
}

/** Convert a ServerTeamMember to the minimal TeamMember shape for card rendering. */
function serverMemberToTeamMember(sm: ServerTeamMember): TeamMember {
  return {
    name: sm.role,
    // Use sessionId as unique identifier — agentId can be shared across members
    agentId: sm.sessionId,
    agentType: sm.agentSlug,
    model: sm.model ?? '',
    joinedAt: 0,
    status: 'unknown',
    toolEvents: [],
    recentTools: [],
    messageCount: 0,
  };
}

export function MobileTeamView({
  members,
  serverMembers = [],
  tasks,
  teamName,
  memberSessions,
  isActive,
  sessionStatus,
}: MobileTeamViewProps) {
  const agentLiveStates = useTeamMonitorStore((s) => s.agentLiveStates);
  const teamStartedAt = useTeamMonitorStore((s) => s.teamStartedAt);

  // Use SSE-derived members when available; fall back to server-fetched members.
  const activeMembers: TeamMember[] =
    members.length > 0 ? members : serverMembers.map(serverMemberToTeamMember);

  if (!isActive || activeMembers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0a0a0f] gap-3 text-center px-6">
        <div className="text-4xl" aria-hidden="true">
          🛰
        </div>
        <p className="text-sm text-zinc-500">Waiting for team to start…</p>
        <p className="text-xs text-zinc-700 font-mono">Session: {sessionStatus ?? 'connecting'}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0f]">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-[rgba(10,10,20,0.9)] backdrop-blur-sm">
        <div
          className="size-2 rounded-full bg-emerald-500 animate-pulse shrink-0"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-white font-mono truncate">
          {teamName ?? 'Agent Team'}
        </span>
        <span className="text-xs text-zinc-500 font-mono ml-auto shrink-0">
          {activeMembers.length} agents
        </span>
      </div>

      {/* Scrollable content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 py-3 space-y-2.5 pb-4">
          {/* Agent cards */}
          {activeMembers.map((member) => {
            const liveState = agentLiveStates.get(member.agentId) ?? null;
            const found = memberSessions.find((ms) => ms.agentId === member.agentId);
            const sessionId = found?.sessionId ?? null;

            return (
              <MobileAgentCard
                key={member.agentId}
                member={member}
                liveState={liveState}
                sessionId={sessionId}
              />
            );
          })}

          {/* Vertical timeline */}
          {activeMembers.length > 0 && <VerticalTimeline className="mt-1" />}
        </div>
      </ScrollArea>

      {/* Bottom action bar */}
      <BottomActionBar
        teamName={teamName}
        tasks={tasks}
        teamStartedAt={teamStartedAt}
        memberSessions={memberSessions}
      />
    </div>
  );
}
