'use client';

import { create } from 'zustand';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';
import { describeToolActivity } from '@/lib/utils/tool-descriptions';

export interface AgentLiveState {
  agentId: string;
  memberName: string;
  sessionId: string | null;
  status: SessionStatus | null;
  isThinking: boolean;
  currentToolName: string | null;
  currentToolInput: Record<string, unknown> | null;
  currentActivity: string | null;
  totalCostUsd: number;
  totalTurns: number;
  contextUsed: number | null;
  contextSize: number | null;
  modelFromInit: string | null;
  sessionStartedAt: number | null;
  recentToolHistory: Array<{ toolName: string; durationMs?: number; ts: number }>;
  hasApprovalPending: boolean;
  hasRateLimit: boolean;
  rateLimitResetsAt: number | null;
}

export interface EdgeAnimation {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  color: string;
  messageType: 'status' | 'correction' | 'error' | 'complete' | 'assignment' | 'other';
  text: string;
  ts: number;
}

function makeDefaultState(
  agentId: string,
  memberName: string,
  sessionId: string | null,
): AgentLiveState {
  return {
    agentId,
    memberName,
    sessionId,
    status: null,
    isThinking: false,
    currentToolName: null,
    currentToolInput: null,
    currentActivity: null,
    totalCostUsd: 0,
    totalTurns: 0,
    contextUsed: null,
    contextSize: null,
    modelFromInit: null,
    sessionStartedAt: null,
    recentToolHistory: [],
    hasApprovalPending: false,
    hasRateLimit: false,
    rateLimitResetsAt: null,
  };
}

interface TeamMonitorState {
  agentLiveStates: Map<string, AgentLiveState>;
  selectedAgentId: string | null;
  activeEdgeAnimations: EdgeAnimation[];
  teamStartedAt: number | null;

  initAgent: (agentId: string, memberName: string, sessionId: string | null) => void;
  handleAgentEvent: (agentId: string, event: AgendoEvent) => void;
  selectAgent: (agentId: string | null) => void;
  addEdgeAnimation: (animation: EdgeAnimation) => void;
  clearEdgeAnimation: (animationId: string) => void;
  reset: () => void;
}

export const useTeamMonitorStore = create<TeamMonitorState>((set) => ({
  agentLiveStates: new Map(),
  selectedAgentId: null,
  activeEdgeAnimations: [],
  teamStartedAt: null,

  initAgent: (agentId, memberName, sessionId) => {
    set((state) => {
      const next = new Map(state.agentLiveStates);
      const existing = next.get(agentId);

      if (!existing) {
        next.set(agentId, makeDefaultState(agentId, memberName, sessionId));
        return { agentLiveStates: next };
      }

      // If sessionId changed, reset live state but keep memberName
      if (existing.sessionId !== sessionId) {
        next.set(agentId, makeDefaultState(agentId, memberName, sessionId));
        return { agentLiveStates: next };
      }

      return {};
    });
  },

  handleAgentEvent: (agentId, event) => {
    set((state) => {
      const current = state.agentLiveStates.get(agentId);
      if (!current) return {};

      const next = new Map(state.agentLiveStates);
      let update: Partial<AgentLiveState> = {};
      let newTeamStartedAt = state.teamStartedAt;

      switch (event.type) {
        case 'session:state': {
          update = { status: event.status };
          break;
        }

        case 'agent:activity': {
          if (event.thinking) {
            update = {
              isThinking: true,
              currentActivity: current.currentToolName ? current.currentActivity : '💭 Thinking…',
              hasRateLimit: false,
              rateLimitResetsAt: null,
            };
          } else {
            update = {
              isThinking: false,
              currentActivity: current.currentToolName ? current.currentActivity : null,
            };
          }
          break;
        }

        case 'agent:tool-start': {
          const described = describeToolActivity(event.toolName, event.input);
          const activity = described ?? `🔧 ${event.toolName}`;
          update = {
            currentToolName: event.toolName,
            currentToolInput: event.input,
            currentActivity: activity,
            hasRateLimit: false,
            rateLimitResetsAt: null,
          };
          break;
        }

        case 'agent:tool-end': {
          const historyEntry = {
            toolName: current.currentToolName ?? 'unknown',
            durationMs: event.durationMs,
            ts: Date.now(),
          };
          const recentToolHistory = [...current.recentToolHistory.slice(-9), historyEntry];
          update = {
            currentToolName: null,
            currentToolInput: null,
            currentActivity: current.isThinking ? '💭 Thinking…' : null,
            recentToolHistory,
          };
          break;
        }

        case 'agent:result': {
          update = {
            totalCostUsd: current.totalCostUsd + (event.costUsd ?? 0),
            totalTurns: event.turns ?? current.totalTurns,
            hasApprovalPending: false,
          };
          break;
        }

        case 'agent:usage': {
          update = {
            contextUsed: event.used,
            contextSize: event.size,
          };
          break;
        }

        case 'session:init': {
          if (state.teamStartedAt === null) {
            newTeamStartedAt = Date.now();
          }
          update = {
            modelFromInit: event.model ?? current.modelFromInit,
            sessionStartedAt: current.sessionStartedAt ?? Date.now(),
          };
          break;
        }

        case 'agent:tool-approval': {
          update = { hasApprovalPending: true };
          break;
        }

        case 'system:rate-limit': {
          // SDK statuses: 'allowed' (ok), 'allowed_warning' (near limit), 'rejected' (blocked)
          // Only show badge when actually rejected — not for informational updates
          const isActuallyLimited = event.status === 'rejected';
          update = {
            hasRateLimit: isActuallyLimited,
            rateLimitResetsAt: isActuallyLimited ? event.resetsAt : null,
          };
          break;
        }

        default:
          return {};
      }

      next.set(agentId, { ...current, ...update });
      return {
        agentLiveStates: next,
        teamStartedAt: newTeamStartedAt,
      };
    });
  },

  selectAgent: (agentId) => set({ selectedAgentId: agentId }),

  addEdgeAnimation: (animation) =>
    set((state) => ({
      activeEdgeAnimations: [...state.activeEdgeAnimations, animation],
    })),

  clearEdgeAnimation: (animationId) =>
    set((state) => ({
      activeEdgeAnimations: state.activeEdgeAnimations.filter((a) => a.id !== animationId),
    })),

  reset: () =>
    set({
      agentLiveStates: new Map(),
      selectedAgentId: null,
      activeEdgeAnimations: [],
      teamStartedAt: null,
    }),
}));
