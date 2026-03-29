'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTeamCanvasStore } from '@/stores/team-canvas-store';
import { TEAM_TEMPLATES, type TeamTemplate } from '@/lib/team-templates';
import { Rocket, Users, ChevronDown, Layout, RotateCcw } from 'lucide-react';

// ============================================================================
// Template Selector
// ============================================================================

interface TemplateSelectorProps {
  onSelect: (template: TeamTemplate) => void;
}

function TemplateSelector({ onSelect }: TemplateSelectorProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="
          flex items-center gap-1.5 px-3 py-1.5 rounded-md
          text-xs text-[#d0d0e0]
          bg-white/[0.04] hover:bg-white/[0.08]
          border border-white/[0.08] hover:border-white/[0.15]
          transition-all duration-150
        "
      >
        <Layout className="w-3.5 h-3.5 text-[#80809a]" />
        Templates
        <ChevronDown
          className={`w-3 h-3 text-[#80809a] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Dropdown */}
          <div className="absolute top-full left-0 mt-1 z-50 w-[300px] rounded-lg bg-[#12121a] border border-white/[0.08] shadow-xl overflow-hidden">
            {TEAM_TEMPLATES.map((template) => (
              <button
                key={template.id}
                onClick={() => {
                  onSelect(template);
                  setOpen(false);
                }}
                className="
                  w-full px-3 py-2.5 text-left
                  hover:bg-white/[0.04]
                  border-b border-white/[0.04] last:border-b-0
                  transition-colors
                "
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{template.icon}</span>
                  <div>
                    <div className="text-xs font-medium text-[#d0d0e0]">{template.name}</div>
                    <div className="text-[10px] text-[#80809a]">{template.description}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Toolbar
// ============================================================================

export function TeamCanvasToolbar() {
  const router = useRouter();
  const teamName = useTeamCanvasStore((s) => s.teamName);
  const setTeamName = useTeamCanvasStore((s) => s.setTeamName);
  const nodes = useTeamCanvasStore((s) => s.nodes);
  const agentConfigs = useTeamCanvasStore((s) => s.agentConfigs);
  const loadTemplate = useTeamCanvasStore((s) => s.loadTemplate);
  const reset = useTeamCanvasStore((s) => s.reset);
  const projectId = useTeamCanvasStore((s) => s.projectId);

  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentNodeCount = nodes.filter((n) => n.type === 'agentNode').length;

  const handleTemplateSelect = useCallback(
    (template: TeamTemplate) => {
      loadTemplate(template.nodes, template.edges, template.configs, template.name);
    },
    [loadTemplate],
  );

  const handleLaunch = useCallback(async () => {
    if (agentNodeCount === 0) {
      setError('Add at least one agent to the canvas');
      return;
    }

    setLaunching(true);
    setError(null);

    try {
      // 1. Create parent task
      const taskBody: Record<string, unknown> = {
        title: teamName || 'Agent Team',
        status: 'in_progress',
      };
      if (projectId) taskBody.projectId = projectId;

      const taskRes = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskBody),
      });
      if (!taskRes.ok) throw new Error('Failed to create parent task');
      const parentTask = (await taskRes.json()) as { id: string };

      // 2. Build members from agent nodes
      const agentNodes = nodes.filter((n) => n.type === 'agentNode');
      const members = agentNodes.map((node) => {
        const config = agentConfigs[node.id];
        if (!config) throw new Error(`Missing config for node ${node.id}`);
        return {
          agent: config.agentSlug,
          role: config.subtaskTitle || `${config.agentSlug} task`,
          prompt: config.initialPrompt || `Complete the task: ${config.subtaskTitle}`,
          permissionMode: config.permissionMode,
          model: config.model,
        };
      });

      // 3. Create team via MCP-style API (direct API calls)
      for (const member of members) {
        // Create subtask
        const subtaskBody: Record<string, unknown> = {
          title: member.role,
          parentTaskId: parentTask.id,
          status: 'todo',
        };
        if (projectId) subtaskBody.projectId = projectId;

        const subtaskRes = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subtaskBody),
        });
        if (!subtaskRes.ok) throw new Error(`Failed to create subtask: ${member.role}`);
        const subtask = (await subtaskRes.json()) as { id: string };

        // Find agent ID from slug
        const agentNode = agentNodes.find((n) => {
          const cfg = agentConfigs[n.id];
          return cfg && cfg.agentSlug === member.agent;
        });
        const agentId = agentNode ? agentConfigs[agentNode.id]?.agentId : undefined;

        if (!agentId) throw new Error(`Cannot resolve agent ID for ${member.agent}`);

        // Spawn session
        const sessionBody: Record<string, unknown> = {
          taskId: subtask.id,
          agentId,
          initialPrompt: member.prompt,
          permissionMode: member.permissionMode,
          teamRole: 'member',
          delegationPolicy: 'forbid',
        };
        if (member.model) sessionBody.model = member.model;

        const sessionRes = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sessionBody),
        });
        if (!sessionRes.ok) {
          const errBody = await sessionRes.text();
          throw new Error(`Failed to spawn session for ${member.role}: ${errBody}`);
        }
      }

      // 4. Navigate to monitor mode
      router.push(`/teams/${parentTask.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
      setLaunching(false);
    }
  }, [agentNodeCount, teamName, projectId, nodes, agentConfigs, router]);

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] bg-[#0a0a0f]/90 backdrop-blur-sm">
      {/* Left: Team name + template */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          className="
            px-2.5 py-1 rounded-md text-sm font-medium text-[#d0d0e0]
            bg-transparent border border-transparent
            hover:border-white/[0.08] focus:border-white/20
            focus:outline-none focus:bg-white/[0.03]
            transition-all w-[200px]
          "
          placeholder="Team name..."
        />

        <TemplateSelector onSelect={handleTemplateSelect} />

        <button
          onClick={reset}
          className="p-1.5 rounded-md hover:bg-white/[0.06] text-[#80809a] hover:text-[#d0d0e0] transition-all"
          title="Clear canvas"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Right: Agent count + Launch */}
      <div className="flex items-center gap-3">
        {/* Agent count */}
        <div className="flex items-center gap-1.5 text-[11px] text-[#80809a]">
          <Users className="w-3.5 h-3.5" />
          <span>
            {agentNodeCount} agent{agentNodeCount !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Error message */}
        {error && <span className="text-[10px] text-red-400 max-w-[200px] truncate">{error}</span>}

        {/* Launch button */}
        <button
          onClick={handleLaunch}
          disabled={launching || agentNodeCount === 0}
          className={`
            flex items-center gap-2 px-4 py-2 rounded-lg
            text-xs font-semibold
            transition-all duration-200
            ${
              launching || agentNodeCount === 0
                ? 'bg-purple-500/20 text-purple-300/50 cursor-not-allowed'
                : 'bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_20px_rgba(139,92,246,0.3)] hover:shadow-[0_0_30px_rgba(139,92,246,0.5)]'
            }
          `}
        >
          <Rocket className={`w-3.5 h-3.5 ${launching ? 'animate-pulse' : ''}`} />
          {launching ? 'Launching...' : 'Launch Team'}
        </button>
      </div>
    </div>
  );
}
