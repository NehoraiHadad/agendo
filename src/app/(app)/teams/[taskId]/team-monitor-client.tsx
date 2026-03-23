'use client';

import { useMemo, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useSessionStream } from '@/hooks/use-session-stream';
import { useTeamCanvasStream, type MemberWithSession } from '@/hooks/use-team-canvas-stream';
import { useTeamMonitorStore } from '@/stores/team-monitor-store';
import type { EdgeAnimation } from '@/stores/team-monitor-store';
import type { SubtaskSession, ServerTeamMember } from '@/components/teams/team-monitor-canvas';

// ── Canvas (desktop only, loaded lazily) ────────────────────────────────────

const TeamMonitorCanvas = dynamic(
  () => import('@/components/teams/team-monitor-canvas').then((m) => m.TeamMonitorCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full bg-[#0a0a0f] text-zinc-600">
        <div className="text-sm">Loading canvas…</div>
      </div>
    ),
  },
);

// ── Message classifier ───────────────────────────────────────────────────────

type TeamMessageEvent = {
  type: 'team:message';
  id: number;
  fromAgent: string;
  text: string;
  summary?: string;
  structuredPayload?: Record<string, unknown>;
};

type TeamOutboxEvent = {
  type: 'team:outbox-message';
  id: number;
  toAgent: string;
  fromAgent: string;
  text: string;
  summary?: string;
  structuredPayload?: Record<string, unknown>;
};

function classifyMessageType(
  payload: Record<string, unknown> | undefined,
): EdgeAnimation['messageType'] {
  const t = payload?.type as string | undefined;
  if (t === 'task_assignment') return 'assignment';
  if (t === 'course_correction') return 'correction';
  if (t === 'idle_notification') return 'complete';
  if (t === 'shutdown_request') return 'error';
  return 'other';
}

// ── Orchestrator (shared stream logic) ───────────────────────────────────────

interface TeamMonitorClientProps {
  leadSessionId: string;
  subtaskSessions: SubtaskSession[];
  taskId: string;
  taskTitle: string;
  teamMembers: ServerTeamMember[];
}

export function TeamMonitorClient({
  leadSessionId,
  subtaskSessions,
  taskId,
  taskTitle,
  teamMembers,
}: TeamMonitorClientProps) {
  const { events } = useSessionStream(leadSessionId);

  const addEdgeAnimation = useTeamMonitorStore((s) => s.addEdgeAnimation);
  const clearEdgeAnimation = useTeamMonitorStore((s) => s.clearEdgeAnimation);

  // Build memberSessions from server-fetched data — sessionId is the unique key
  // (agentId can repeat when multiple subtasks use the same agent)
  const memberSessions = useMemo<MemberWithSession[]>(() => {
    return teamMembers.map((tm) => ({
      agentId: tm.sessionId, // sessionId as unique member key
      memberName: tm.role,
      sessionId: tm.sessionId,
    }));
  }, [teamMembers]);

  // Stream events for all member sessions into Zustand store
  useTeamCanvasStream(memberSessions);

  // Edge animations for team messages — match by role name to sessionId
  const memberByRole = useMemo(() => {
    const map = new Map<string, string>(); // role → sessionId (unique key)
    for (const tm of teamMembers) {
      map.set(tm.role, tm.sessionId);
    }
    return map;
  }, [teamMembers]);

  useEffect(() => {
    if (events.length === 0 || teamMembers.length < 2) return;
    const lastEvent = events[events.length - 1];
    if (lastEvent?.type !== 'team:message' && lastEvent?.type !== 'team:outbox-message') return;

    // First member is the lead (convention)
    const leadId = teamMembers[0].sessionId;

    let fromId: string;
    let toId: string;
    let text = '';
    let payload: Record<string, unknown> | undefined;

    if (lastEvent.type === 'team:message') {
      const msg = lastEvent as unknown as TeamMessageEvent;
      const fromSessionId = memberByRole.get(msg.fromAgent);
      if (!fromSessionId) return;
      fromId = fromSessionId;
      toId = leadId;
      text = msg.summary ?? msg.text.slice(0, 80);
      payload = msg.structuredPayload;
    } else {
      const msg = lastEvent as unknown as TeamOutboxEvent;
      const toSessionId = memberByRole.get(msg.toAgent);
      if (!toSessionId) return;
      fromId = leadId;
      toId = toSessionId;
      text = msg.summary ?? msg.text.slice(0, 80);
      payload = msg.structuredPayload;
    }

    const messageType = classifyMessageType(payload);
    const animId = `${fromId}-${toId}-${lastEvent.id}`;

    addEdgeAnimation({
      id: animId,
      fromAgentId: fromId,
      toAgentId: toId,
      color: '#3B82F6',
      messageType,
      text,
      ts: Date.now(),
    });

    const timer = setTimeout(() => clearEdgeAnimation(animId), 3000);
    return () => clearTimeout(timer);
  }, [events, teamMembers, memberByRole, addEdgeAnimation, clearEdgeAnimation]);

  return (
    <div className="h-[calc(100vh-4rem)]">
      <TeamMonitorCanvas
        leadSessionId={leadSessionId}
        subtaskSessions={subtaskSessions}
        taskId={taskId}
        taskTitle={taskTitle}
        serverMembers={teamMembers}
      />
    </div>
  );
}
