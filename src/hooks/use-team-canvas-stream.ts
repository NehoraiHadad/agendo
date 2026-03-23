'use client';

import { useEffect, useRef } from 'react';
import type { AgendoEvent } from '@/lib/realtime/events';
import { useTeamMonitorStore } from '@/stores/team-monitor-store';

const HIGH_VOLUME_EVENT_TYPES = new Set([
  'agent:text-delta',
  'agent:thinking-delta',
  'agent:tool-progress',
]);

const BASE_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30_000;

export interface MemberWithSession {
  agentId: string;
  memberName: string;
  sessionId: string | null;
}

class TeamStreamManager {
  onEvent: (agentId: string, event: AgendoEvent) => void;

  private connections = new Map<string, EventSource>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private retryDelays = new Map<string, number>();
  private lastEventIds = new Map<string, number>();
  private sessionToAgent = new Map<string, string>();
  private isDead = false;

  constructor(onEvent: (agentId: string, event: AgendoEvent) => void) {
    this.onEvent = onEvent;
  }

  private connect(agentId: string, sessionId: string): void {
    if (this.isDead) return;
    const lastId = this.lastEventIds.get(sessionId) ?? 0;
    const url =
      lastId > 0
        ? `/api/sessions/${sessionId}/events?lastEventId=${lastId}`
        : `/api/sessions/${sessionId}/events`;

    const es = new EventSource(url);
    this.connections.set(sessionId, es);
    this.sessionToAgent.set(sessionId, agentId);

    es.onopen = () => {
      this.retryDelays.set(sessionId, BASE_RETRY_DELAY);
    };

    es.onmessage = (event: MessageEvent) => {
      if (this.isDead) return;
      try {
        const parsed = JSON.parse(event.data as string) as AgendoEvent;
        if (event.lastEventId) {
          const id = parseInt(event.lastEventId, 10);
          if (!isNaN(id)) this.lastEventIds.set(sessionId, id);
        }
        if (HIGH_VOLUME_EVENT_TYPES.has(parsed.type)) return;
        this.onEvent(agentId, parsed);
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      if (this.isDead) return;
      es.close();
      this.connections.delete(sessionId);
      const delay = this.retryDelays.get(sessionId) ?? BASE_RETRY_DELAY;
      this.retryDelays.set(sessionId, Math.min(delay * 2, MAX_RETRY_DELAY));
      const timer = setTimeout(() => {
        if (!this.isDead && this.sessionToAgent.has(sessionId)) {
          this.connect(agentId, sessionId);
        }
      }, delay);
      this.retryTimers.set(sessionId, timer);
    };
  }

  updateMembers(members: MemberWithSession[]): void {
    const activeSessionIds = new Set(
      members.map((m) => m.sessionId).filter((s): s is string => s !== null),
    );

    // Close connections for removed sessions
    for (const [sessionId, es] of this.connections) {
      if (!activeSessionIds.has(sessionId)) {
        es.close();
        this.connections.delete(sessionId);
        this.sessionToAgent.delete(sessionId);
        clearTimeout(this.retryTimers.get(sessionId));
        this.retryTimers.delete(sessionId);
      }
    }

    // Open connections for new sessions
    for (const member of members) {
      if (!member.sessionId) continue;
      if (!this.connections.has(member.sessionId)) {
        this.connect(member.agentId, member.sessionId);
      } else {
        this.sessionToAgent.set(member.sessionId, member.agentId);
      }
    }
  }

  destroy(): void {
    this.isDead = true;
    for (const es of this.connections.values()) es.close();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.connections.clear();
    this.retryTimers.clear();
    this.sessionToAgent.clear();
  }
}

export function useTeamCanvasStream(members: MemberWithSession[]): void {
  const handleAgentEvent = useTeamMonitorStore((s) => s.handleAgentEvent);
  const initAgent = useTeamMonitorStore((s) => s.initAgent);
  const managerRef = useRef<TeamStreamManager | null>(null);

  // Create manager once
  useEffect(() => {
    managerRef.current = new TeamStreamManager(handleAgentEvent);
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update connections when members change
  useEffect(() => {
    for (const m of members) {
      initAgent(m.agentId, m.memberName, m.sessionId);
    }
    managerRef.current?.updateMembers(members);
  }, [members, initAgent]);

  // Keep onEvent reference up to date
  useEffect(() => {
    if (managerRef.current) {
      managerRef.current.onEvent = handleAgentEvent;
    }
  }, [handleAgentEvent]);
}
