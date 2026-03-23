'use client';

import { useCallback, useMemo, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTeamMonitorStore } from '@/stores/team-monitor-store';
import { LiveAgentCard, type LiveAgentNode, type LiveAgentCardData } from './live-agent-card';
import {
  MessageFlowEdge,
  type MessageFlowEdgeType,
  type MessageFlowEdgeData,
} from './message-flow-edge';
import { AgentActivitySheet } from './agent-activity-sheet';
import type { TeamMember } from '@/hooks/use-team-state';
import { Square, Clock, Users, Activity, CheckCircle2, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-types';
import { toast } from 'sonner';

const NODE_TYPES = { liveAgent: LiveAgentCard };
const EDGE_TYPES = { messageFlow: MessageFlowEdge };

export interface SubtaskSession {
  subtaskId: string;
  sessionId: string;
  agentId: string;
  status: string;
}

/**
 * Server-fetched team member data — populated from DB at page load so the
 * canvas renders immediately without waiting for a `team:config` SSE event.
 */
export interface ServerTeamMember {
  agentId: string;
  agentName: string;
  agentSlug: string;
  /** Subtask title — serves as this agent's role in the team */
  role: string;
  sessionId: string;
  sessionStatus: string;
  model: string | null;
  subtaskId: string;
}

interface TeamMonitorCanvasProps {
  leadSessionId: string;
  subtaskSessions: SubtaskSession[];
  taskId: string;
  /** Parent task title — used as the team name when SSE team:config is absent */
  taskTitle: string;
  /** Pre-fetched members from DB — makes the canvas render without SSE */
  serverMembers: ServerTeamMember[];
}

function buildNodes(
  members: TeamMember[],
  onSelectAgent: (agentId: string) => void,
  subtaskDoneMap: Map<string, number>,
  subtaskTotalMap: Map<string, number>,
): LiveAgentNode[] {
  const colCount = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  return members.map((member, i) => {
    const col = i % colCount;
    const row = Math.floor(i / colCount);
    return {
      id: member.agentId,
      type: 'liveAgent' as const,
      position: { x: col * 300 + 60, y: row * 240 + 60 },
      data: {
        member,
        subtaskDone: subtaskDoneMap.get(member.agentId) ?? 0,
        subtaskTotal: subtaskTotalMap.get(member.agentId) ?? 0,
        onSelectAgent,
      } satisfies LiveAgentCardData,
    };
  });
}

function buildEdges(members: TeamMember[]): MessageFlowEdgeType[] {
  if (members.length < 2) return [];
  const lead = members[0];
  return members.slice(1).map((m) => ({
    id: `${lead.agentId}-${m.agentId}`,
    source: lead.agentId,
    target: m.agentId,
    type: 'messageFlow' as const,
    data: {
      fromAgentId: lead.agentId,
      toAgentId: m.agentId,
      edgeId: `${lead.agentId}-${m.agentId}`,
    } satisfies MessageFlowEdgeData,
  }));
}

function ElapsedTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!startedAt) return <span className="text-zinc-700">—</span>;
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

interface StatusCountsData {
  active: number;
  waiting: number;
  done: number;
  idle: number;
}

function StatusCounts({ counts }: { counts: StatusCountsData }) {
  return (
    <div className="flex items-center gap-3 text-[10px] font-mono">
      {counts.active > 0 && (
        <span className="flex items-center gap-1 text-emerald-400">
          <Activity className="size-2.5" />
          {counts.active}
        </span>
      )}
      {counts.waiting > 0 && (
        <span className="flex items-center gap-1 text-amber-400">
          <Circle className="size-2.5" />
          {counts.waiting}
        </span>
      )}
      {counts.done > 0 && (
        <span className="flex items-center gap-1 text-blue-400">
          <CheckCircle2 className="size-2.5" />
          {counts.done}
        </span>
      )}
      {counts.idle > 0 && (
        <span className="flex items-center gap-1 text-zinc-600">
          <Circle className="size-2.5" />
          {counts.idle}
        </span>
      )}
    </div>
  );
}

/**
 * Convert a ServerTeamMember (DB-fetched) into the TeamMember shape that the
 * canvas helpers expect.  Live fields (status, tool events, etc.) start at
 * their zero values and are updated via SSE once the lead session connects.
 */
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

export function TeamMonitorCanvas({
  leadSessionId: _leadSessionId,
  subtaskSessions: _subtaskSessions,
  taskId: _taskId,
  taskTitle,
  serverMembers,
}: TeamMonitorCanvasProps) {
  const selectedAgentId = useTeamMonitorStore((s) => s.selectedAgentId);
  const selectAgent = useTeamMonitorStore((s) => s.selectAgent);
  const teamStartedAt = useTeamMonitorStore((s) => s.teamStartedAt);
  const agentLiveStates = useTeamMonitorStore((s) => s.agentLiveStates);

  const [stopConfirm, setStopConfirm] = useState(false);

  // Build members from server data — sessionId is the unique key (agentId can repeat)
  const activeMembers = useMemo<TeamMember[]>(
    () => serverMembers.map(serverMemberToTeamMember),
    [serverMembers],
  );

  // Derive live status counts from agentLiveStates
  const statusCounts = useMemo<StatusCountsData>(() => {
    const counts: StatusCountsData = { active: 0, waiting: 0, done: 0, idle: 0 };
    agentLiveStates.forEach((s) => {
      if (s.status === 'active') counts.active++;
      else if (s.status === 'awaiting_input') counts.waiting++;
      else if (s.status === 'ended') counts.done++;
      else counts.idle++;
    });
    // Fall back to member count as idle when no live state yet
    if (agentLiveStates.size === 0) counts.idle = activeMembers.length;
    return counts;
  }, [agentLiveStates, activeMembers.length]);

  const totalCost = useMemo(
    () => Array.from(agentLiveStates.values()).reduce((sum, s) => sum + s.totalCostUsd, 0),
    [agentLiveStates],
  );

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      selectAgent(agentId);
    },
    [selectAgent],
  );

  // Build node/edge IDs string for memoization stability
  const memberIdKey = activeMembers.map((m) => m.agentId).join(',');

  const initialNodes = useMemo(
    () => buildNodes(activeMembers, handleSelectAgent, new Map(), new Map()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberIdKey, handleSelectAgent],
  );

  const initialEdges = useMemo(
    () => buildEdges(activeMembers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberIdKey],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes as unknown as Node[]);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges as unknown as Edge[]);

  // Sync node data when members update (preserve positions)
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        const member = activeMembers.find((m) => m.agentId === node.id);
        if (!member) return node;
        const existingData = node.data as unknown as LiveAgentCardData;
        return {
          ...node,
          data: {
            ...existingData,
            member,
          } as unknown as Record<string, unknown>,
        };
      }),
    );
  }, [activeMembers, setNodes]);

  const selectedMember = activeMembers.find((m) => m.agentId === selectedAgentId) ?? null;
  const selectedLiveState = selectedAgentId ? (agentLiveStates.get(selectedAgentId) ?? null) : null;
  // member.agentId is sessionId (unique key)
  const selectedMemberSession = selectedAgentId ?? null;

  const handleStopAll = useCallback(async () => {
    if (!stopConfirm) {
      setStopConfirm(true);
      setTimeout(() => setStopConfirm(false), 3500);
      return;
    }
    setStopConfirm(false);
    const results = await Promise.allSettled(
      serverMembers
        .filter((sm) => sm.sessionId)
        .map((sm) =>
          apiFetch<unknown>(`/api/sessions/${sm.sessionId}/cancel`, {
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
  }, [serverMembers, stopConfirm]);

  // Show empty state only if there are truly no members
  if (activeMembers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0a0f] text-zinc-600">
        <div className="text-center space-y-3">
          <div className="text-5xl opacity-40">🛰</div>
          <div className="text-xs font-mono tracking-widest text-zinc-600">NO AGENTS ONLINE</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0f]">
      {/* ── Command bar ──────────────────────────────────────────── */}
      <div
        className="shrink-0 flex items-center border-b border-white/[0.05]"
        style={{ background: 'rgba(8,8,16,0.97)', backdropFilter: 'blur(12px)' }}
      >
        {/* Team identity */}
        <div className="flex items-center gap-2.5 px-4 py-2.5 border-r border-white/[0.05] shrink-0">
          <div className="relative size-2">
            <span className="absolute inset-0 rounded-full bg-emerald-500/40 animate-ping" />
            <span className="relative block size-2 rounded-full bg-emerald-500" />
          </div>
          <span className="text-[11px] font-semibold text-white/90 font-mono max-w-[200px] truncate">
            {taskTitle}
          </span>
        </div>

        {/* Elapsed timer */}
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-r border-white/[0.05] text-[10px] text-zinc-500 font-mono shrink-0">
          <Clock className="size-3 text-zinc-600" />
          <ElapsedTimer startedAt={teamStartedAt} />
        </div>

        {/* Member count */}
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-r border-white/[0.05] text-[10px] text-zinc-500 font-mono shrink-0">
          <Users className="size-3 text-zinc-600" />
          <span>{serverMembers.length}</span>
          <span className="text-zinc-700">agents</span>
        </div>

        {/* Live status counts */}
        <div className="px-4 py-2.5 border-r border-white/[0.05] shrink-0">
          <StatusCounts counts={statusCounts} />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Total cost */}
        {totalCost > 0 && (
          <div className="flex items-center gap-1 px-3 py-2.5 text-[10px] font-mono text-zinc-600 shrink-0">
            <span className="text-zinc-700">$</span>
            <span>{totalCost.toFixed(3)}</span>
          </div>
        )}

        {/* Stop All — two-step confirm */}
        <div className="px-3 py-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className={[
              'h-7 text-[10px] font-mono gap-1.5 transition-all duration-200',
              stopConfirm
                ? 'border-red-500/70 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'border-zinc-700 bg-transparent text-zinc-500 hover:border-red-500/40 hover:text-red-400',
            ].join(' ')}
            onClick={() => void handleStopAll()}
          >
            <Square className="size-2.5" />
            {stopConfirm ? 'CONFIRM?' : 'STOP ALL'}
          </Button>
        </div>
      </div>

      {/* ── Canvas ───────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.25}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={28}
            size={1}
            color="rgba(40,40,64,0.5)"
          />
          <Controls
            className="!bg-[rgba(8,8,16,0.9)] !border-white/[0.07] !rounded-lg"
            showInteractive={false}
          />
          <MiniMap
            className="!bg-[rgba(8,8,16,0.9)] !border-white/[0.07] !rounded-lg"
            nodeColor="#1a1a2e"
            maskColor="rgba(0,0,0,0.5)"
          />
        </ReactFlow>
      </div>

      <AgentActivitySheet
        member={selectedMember}
        liveState={selectedLiveState}
        sessionId={selectedMemberSession}
        isOpen={!!selectedAgentId}
        onClose={() => selectAgent(null)}
      />
    </div>
  );
}
