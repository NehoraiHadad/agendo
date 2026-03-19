import { useMemo } from 'react';
import type { AgendoEvent } from '@/lib/realtime/events';
import { describeToolActivity } from '@/lib/utils/tool-descriptions';

/** A tool call observed from a teammate (via permission_request or other structured messages). */
export interface AgentToolEvent {
  toolName: string;
  description?: string;
  filePath?: string;
  timestamp: string;
}

export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  model: string;
  color?: string;
  planModeRequired?: boolean;
  joinedAt: number;
  /** Derived from message history: idle/active/unknown */
  status: 'active' | 'idle' | 'unknown';
  /** ISO timestamp of last idle_notification from this agent */
  lastIdleAt?: string;
  /** Tool calls observed from this agent (from permission_request messages) */
  toolEvents: AgentToolEvent[];
  /** Unique tool names recently used */
  recentTools: string[];
  /** Human-readable current activity (e.g. "editing file.tsx", "idle") */
  currentActivity?: string;
  /** Total non-idle messages sent by this agent */
  messageCount: number;
}

export interface TeamTask {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  blocks: string[];
  blockedBy: string[];
}

export interface ActiveSubagent {
  agentId: string;
  toolUseId: string;
  subagentType?: string;
  description?: string;
  status: 'running' | 'complete' | 'failed';
}

export interface TeamState {
  teamName: string | null;
  /** True once a team:config event has been received */
  isActive: boolean;
  members: TeamMember[];
  /** team:message events grouped by fromAgent */
  messagesByAgent: Record<string, AgendoEvent[]>;
  /** team:outbox-message events grouped by toAgent */
  outboxByAgent: Record<string, AgendoEvent[]>;
  tasks: TeamTask[];
  subagents: ActiveSubagent[];
}

const EMPTY_STATE: TeamState = {
  teamName: null,
  isActive: false,
  members: [],
  messagesByAgent: {},
  outboxByAgent: {},
  tasks: [],
  subagents: [],
};

/**
 * Derive structured team state from the flat session events array.
 * All derived values are memoized — only recomputes when events changes.
 */
export function useTeamState(events: AgendoEvent[]): TeamState {
  return useMemo(() => {
    // Find the most recent team:config event
    const lastConfig = [...events].reverse().find((e) => e.type === 'team:config');
    if (!lastConfig || lastConfig.type !== 'team:config') {
      return EMPTY_STATE;
    }

    const { teamName, members: configMembers } = lastConfig;

    // Group inbound messages (teammate → lead) by fromAgent
    const messagesByAgent: Record<string, AgendoEvent[]> = {};
    for (const event of events) {
      if (event.type === 'team:message') {
        const key = event.fromAgent;
        if (!messagesByAgent[key]) messagesByAgent[key] = [];
        messagesByAgent[key].push(event);
      }
    }

    // Group outbound messages (lead → teammate) by toAgent
    const outboxByAgent: Record<string, AgendoEvent[]> = {};
    for (const event of events) {
      if (event.type === 'team:outbox-message') {
        const key = event.toAgent;
        if (!outboxByAgent[key]) outboxByAgent[key] = [];
        outboxByAgent[key].push(event);
      }
    }

    // Derive member status, tool activity, and current activity from message history
    const members: TeamMember[] = configMembers.map((cm) => {
      const agentMessages = messagesByAgent[cm.name] ?? [];

      let lastIdleAt: string | undefined;
      let lastActiveTs: number | undefined;
      const toolEvents: AgentToolEvent[] = [];
      let messageCount = 0;

      for (const msg of agentMessages) {
        if (msg.type !== 'team:message') continue;

        if (msg.isStructured && msg.structuredPayload?.type === 'idle_notification') {
          if (!lastIdleAt || msg.sourceTimestamp > lastIdleAt) {
            lastIdleAt = msg.sourceTimestamp;
          }
        } else {
          messageCount++;
          if (lastActiveTs === undefined || msg.ts > lastActiveTs) {
            lastActiveTs = msg.ts;
          }
        }

        // Extract tool activity from permission_request messages
        if (msg.isStructured && msg.structuredPayload?.type === 'permission_request') {
          const payload = msg.structuredPayload;
          const toolName = payload.tool_name as string | undefined;
          if (toolName) {
            const input = payload.input as Record<string, unknown> | undefined;
            // Try to extract file path from common tool inputs
            const filePath =
              (input?.file_path as string) ??
              (input?.path as string) ??
              (input?.filePath as string) ??
              undefined;
            toolEvents.push({
              toolName,
              description: payload.description as string | undefined,
              filePath,
              timestamp: msg.sourceTimestamp,
            });
          }
        }
      }

      let status: TeamMember['status'] = 'unknown';
      if (lastIdleAt !== undefined || lastActiveTs !== undefined) {
        if (lastIdleAt !== undefined && lastActiveTs !== undefined) {
          const idleTime = new Date(lastIdleAt).getTime();
          status = lastActiveTs > idleTime ? 'active' : 'idle';
        } else if (lastActiveTs !== undefined) {
          status = 'active';
        } else {
          status = 'idle';
        }
      }

      // Derive recent tools (unique, last 5)
      const recentTools = [...new Set(toolEvents.slice(-5).map((te) => te.toolName))];

      // Derive current activity description
      let currentActivity: string | undefined;
      if (status === 'idle') {
        currentActivity = 'idle';
      } else if (toolEvents.length > 0) {
        const lastTool = toolEvents[toolEvents.length - 1];
        currentActivity =
          describeToolActivity(lastTool.toolName, { file_path: lastTool.filePath }) ??
          lastTool.toolName;
      } else if (status === 'active') {
        currentActivity = 'working';
      }

      return {
        name: cm.name,
        agentId: cm.agentId,
        agentType: cm.agentType,
        model: cm.model,
        color: cm.color,
        planModeRequired: cm.planModeRequired,
        joinedAt: cm.joinedAt,
        status,
        lastIdleAt,
        toolEvents,
        recentTools,
        currentActivity,
        messageCount,
      };
    });

    // Latest task snapshot (team:task-update is a full snapshot, not a diff)
    const lastTaskUpdate = [...events].reverse().find((e) => e.type === 'team:task-update');
    const tasks: TeamTask[] =
      lastTaskUpdate && lastTaskUpdate.type === 'team:task-update' ? lastTaskUpdate.tasks : [];

    // Build subagent map — subagent:start creates an entry, subagent:complete updates it
    const subagentMap = new Map<string, ActiveSubagent>();
    for (const event of events) {
      if (event.type === 'subagent:start') {
        subagentMap.set(event.agentId, {
          agentId: event.agentId,
          toolUseId: event.toolUseId,
          subagentType: event.subagentType,
          description: event.description,
          status: 'running',
        });
      } else if (event.type === 'subagent:complete') {
        const existing = subagentMap.get(event.agentId);
        if (existing) {
          subagentMap.set(event.agentId, {
            ...existing,
            status: event.success ? 'complete' : 'failed',
          });
        }
      }
    }
    const subagents = Array.from(subagentMap.values());

    return {
      teamName,
      isActive: true,
      members,
      messagesByAgent,
      outboxByAgent,
      tasks,
      subagents,
    };
  }, [events]);
}
