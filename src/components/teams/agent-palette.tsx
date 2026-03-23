'use client';

import { useEffect, useState, useCallback } from 'react';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { useTeamCanvasStore, getAgentAccentColor } from '@/stores/team-canvas-store';
import type { AgentInfo } from '@/stores/team-canvas-store';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';

// ============================================================================
// Agent descriptions fallback
// ============================================================================

const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Anthropic's Claude — best for complex reasoning, writing, and multi-file edits",
  codex: 'OpenAI Codex — fast code generation and review with sandbox execution',
  gemini: 'Google Gemini — strong at research, analysis, and design tasks',
  copilot: 'GitHub Copilot — code suggestions and completions with GitHub integration',
};

function getDescription(slug: string): string {
  const normalized = slug.toLowerCase();
  for (const [prefix, desc] of Object.entries(AGENT_DESCRIPTIONS)) {
    if (normalized.startsWith(prefix)) return desc;
  }
  return 'AI coding agent';
}

// ============================================================================
// Draggable Agent Card
// ============================================================================

interface DraggableAgentCardProps {
  agent: AgentInfo;
  onAdd: (agent: AgentInfo) => void;
}

function DraggableAgentCard({ agent, onAdd }: DraggableAgentCardProps) {
  const accentColor = getAgentAccentColor(agent.slug);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData('application/agendo-agent', JSON.stringify(agent));
      e.dataTransfer.effectAllowed = 'move';
    },
    [agent],
  );

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className="
        group relative p-3 rounded-lg cursor-grab active:cursor-grabbing
        bg-white/[0.03] hover:bg-white/[0.06]
        border border-white/[0.06] hover:border-white/[0.12]
        transition-all duration-200
      "
      style={{
        borderLeftWidth: '2px',
        borderLeftColor: accentColor,
      }}
    >
      <div className="flex items-start gap-2.5">
        <AgentAvatar name={agent.name} slug={agent.slug} size="md" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-[#d0d0e0]">{agent.name}</div>
          <div className="text-[10px] text-[#80809a] mt-0.5 line-clamp-2">
            {getDescription(agent.slug)}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAdd(agent);
          }}
          className="
            opacity-0 group-hover:opacity-100
            p-1 rounded-md
            bg-white/[0.06] hover:bg-white/[0.12]
            text-[#80809a] hover:text-[#d0d0e0]
            transition-all duration-150
          "
          title={`Add ${agent.name} to canvas`}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Agent Palette
// ============================================================================

export function AgentPalette() {
  const [collapsed, setCollapsed] = useState(false);
  const availableAgents = useTeamCanvasStore((s) => s.availableAgents);
  const setAvailableAgents = useTeamCanvasStore((s) => s.setAvailableAgents);
  const addAgentNode = useTeamCanvasStore((s) => s.addAgentNode);
  const getAgentNodeCount = useTeamCanvasStore((s) => s.getAgentNodeCount);

  // Fetch agents on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) return;
        const data = (await res.json()) as { data: AgentInfo[] };
        if (!cancelled) {
          setAvailableAgents(data.data ?? []);
        }
      } catch {
        // silently ignore
      }
    }
    if (availableAgents.length === 0) {
      void fetchAgents();
    }
    return () => {
      cancelled = true;
    };
  }, [availableAgents.length, setAvailableAgents]);

  const handleQuickAdd = useCallback(
    (agent: AgentInfo) => {
      const count = getAgentNodeCount();
      // Stagger positions for quick-add
      const x = 200 + (count % 3) * 260;
      const y = 120 + Math.floor(count / 3) * 200;
      addAgentNode(agent, { x, y });
    },
    [addAgentNode, getAgentNodeCount],
  );

  if (collapsed) {
    return (
      <div className="flex flex-col items-center py-3 px-1 border-r border-white/[0.06] bg-[#0a0a0f]/80">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[#80809a] hover:text-[#d0d0e0] transition-all"
          title="Expand palette"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        {/* Mini agent icons */}
        <div className="mt-3 flex flex-col gap-2">
          {availableAgents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => handleQuickAdd(agent)}
              title={`Add ${agent.name}`}
            >
              <AgentAvatar name={agent.name} slug={agent.slug} size="xs" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-[240px] shrink-0 border-r border-white/[0.06] bg-[#0a0a0f]/80 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/[0.06]">
        <span className="text-xs font-semibold text-[#d0d0e0] uppercase tracking-wider">
          Agents
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 rounded-md hover:bg-white/[0.06] text-[#80809a] hover:text-[#d0d0e0] transition-all"
          title="Collapse palette"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        <p className="text-[10px] text-[#80809a] px-1 mb-2">
          Drag agents onto the canvas or click + to add
        </p>
        {availableAgents.map((agent) => (
          <DraggableAgentCard key={agent.id} agent={agent} onAdd={handleQuickAdd} />
        ))}
        {availableAgents.length === 0 && (
          <div className="text-[10px] text-[#80809a] text-center py-8">Loading agents...</div>
        )}
      </div>
    </div>
  );
}
