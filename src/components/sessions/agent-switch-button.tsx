'use client';

import { useState, useRef, useEffect } from 'react';
import { ArrowLeftRight, Loader2 } from 'lucide-react';
import { useFetch } from '@/hooks/use-fetch';
import { Button } from '@/components/ui/button';
import { getTeamColor } from '@/lib/utils/team-colors';
import { agentColorKey } from '@/lib/utils/agent-switch-colors';

interface AgentRow {
  id: string;
  name: string;
  isActive: boolean;
}

export interface AgentSwitchButtonProps {
  currentAgentId: string;
  /** Unused at runtime but kept in the interface so callers can display the label. */
  currentAgentName?: string;
  sessionEnded: boolean;
  onSelect: (agentId: string, agentName: string) => void;
}

export function AgentSwitchButton({
  currentAgentId,
  sessionEnded,
  onSelect,
}: AgentSwitchButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: agents, isLoading: loading } = useFetch<AgentRow[]>('/api/agents?group=ai', {
    transform: (json: unknown) =>
      ((json as { data: AgentRow[] })?.data ?? []).filter((a) => a.isActive),
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (agent: AgentRow) => {
    setOpen(false);
    onSelect(agent.id, agent.name);
  };

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="ghost"
        size="sm"
        disabled={sessionEnded}
        onClick={() => setOpen((v) => !v)}
        title="Switch to a different agent"
        className="h-7 px-2.5 text-xs border gap-1.5 active:scale-95 transition-all text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 border-orange-500/20"
      >
        <ArrowLeftRight className="size-3" />
        <span>Agent</span>
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-xl border border-white/[0.08] bg-[oklch(0.11_0_0)] shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="px-3 pt-3 pb-2">
            <p className="text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider">
              Switch agent
            </p>
            <p className="text-[10px] text-muted-foreground/30 mt-0.5">
              Forks this session for a new agent
            </p>
          </div>

          <div className="h-px bg-white/[0.06] mx-3 mb-1" />

          {/* Agent list */}
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground/40" />
            </div>
          ) : !agents || agents.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground/40">
              No other agents available
            </div>
          ) : (
            <div className="pb-1.5">
              {agents.map((agent) => {
                const isCurrent = agent.id === currentAgentId;
                const colorKey = agentColorKey(agent.name);
                const color = getTeamColor(colorKey);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => !isCurrent && handleSelect(agent)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
                      isCurrent
                        ? 'pointer-events-none opacity-40'
                        : 'hover:bg-white/[0.05] active:bg-white/[0.08]'
                    }`}
                  >
                    <span className={`size-1.5 rounded-full shrink-0 ${color.pulse}`} />
                    <span className="flex-1 text-xs text-foreground/80 truncate">{agent.name}</span>
                    {isCurrent && (
                      <span className="text-[10px] text-muted-foreground/35 font-mono shrink-0">
                        current
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
