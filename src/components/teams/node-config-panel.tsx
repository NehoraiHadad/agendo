'use client';

import { useCallback } from 'react';
import { useTeamCanvasStore, getAgentAccentColor } from '@/stores/team-canvas-store';
import type { AgentNodeConfig } from '@/stores/team-canvas-store';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { X, Trash2 } from 'lucide-react';

// ============================================================================
// Model options per agent type
// ============================================================================

const MODEL_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  claude: [
    { value: 'haiku', label: 'Haiku (fast, cheap)' },
    { value: 'sonnet', label: 'Sonnet (balanced)' },
    { value: 'opus', label: 'Opus (most capable)' },
  ],
  codex: [
    { value: 'codex-mini', label: 'Codex Mini (fast)' },
    { value: 'o3', label: 'O3 (reasoning)' },
    { value: 'o4-mini', label: 'O4 Mini' },
  ],
  gemini: [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (fast)' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  copilot: [
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  ],
};

function getModelsForAgent(slug: string): Array<{ value: string; label: string }> {
  const normalized = slug.toLowerCase();
  for (const [prefix, models] of Object.entries(MODEL_OPTIONS)) {
    if (normalized.startsWith(prefix)) return models;
  }
  return [{ value: 'default', label: 'Default' }];
}

const PERMISSION_OPTIONS = [
  { value: 'bypassPermissions', label: 'Autonomous', description: 'Auto-approve everything' },
  {
    value: 'acceptEdits',
    label: 'Edits Only',
    description: 'Auto-approve file edits, block bash/MCP',
  },
  { value: 'default', label: 'Manual', description: 'Prompt for all approvals' },
] as const;

// ============================================================================
// Component
// ============================================================================

export function NodeConfigPanel() {
  const selectedNodeId = useTeamCanvasStore((s) => s.selectedNodeId);
  const nodes = useTeamCanvasStore((s) => s.nodes);
  const agentConfigs = useTeamCanvasStore((s) => s.agentConfigs);
  const updateAgentConfig = useTeamCanvasStore((s) => s.updateAgentConfig);
  const setSelectedNodeId = useTeamCanvasStore((s) => s.setSelectedNodeId);
  const removeNode = useTeamCanvasStore((s) => s.removeNode);

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null;
  const config = selectedNodeId ? agentConfigs[selectedNodeId] : undefined;

  const handleConfigChange = useCallback(
    (field: keyof AgentNodeConfig, value: string) => {
      if (!selectedNodeId) return;
      updateAgentConfig(selectedNodeId, { [field]: value });
    },
    [selectedNodeId, updateAgentConfig],
  );

  const handleRemove = useCallback(() => {
    if (!selectedNodeId) return;
    removeNode(selectedNodeId);
  }, [selectedNodeId, removeNode]);

  // Nothing selected
  if (!selectedNode || !config) {
    return (
      <div className="w-[320px] shrink-0 border-l border-white/[0.06] bg-[#0a0a0f]/80 flex flex-col">
        <div className="flex items-center px-4 py-3 border-b border-white/[0.06]">
          <span className="text-xs font-semibold text-[#d0d0e0] uppercase tracking-wider">
            Configuration
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-[#80809a] text-center">
            Select an agent node on the canvas to configure it
          </p>
        </div>
      </div>
    );
  }

  const isAgentNode = selectedNode.type === 'agentNode';
  const accentColor = isAgentNode ? getAgentAccentColor(config.agentSlug) : '#6B7280';
  const modelOptions = getModelsForAgent(config.agentSlug);

  return (
    <div className="w-[320px] shrink-0 border-l border-white/[0.06] bg-[#0a0a0f]/80 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <span className="text-xs font-semibold text-[#d0d0e0] uppercase tracking-wider">
          Configuration
        </span>
        <button
          onClick={() => setSelectedNodeId(null)}
          className="p-1 rounded-md hover:bg-white/[0.06] text-[#80809a] hover:text-[#d0d0e0] transition-all"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Agent header */}
      {isAgentNode && (
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <AgentAvatar name={config.agentSlug} slug={config.agentSlug} size="lg" />
            <div>
              <div className="text-sm font-medium text-[#d0d0e0]">
                {selectedNode.data.agentName as string}
              </div>
              <div className="text-[10px] text-[#80809a]">{config.agentSlug}</div>
            </div>
          </div>
        </div>
      )}

      {/* Config form */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Subtask title */}
        <div>
          <label className="block text-[10px] font-semibold text-[#80809a] uppercase tracking-wider mb-1.5">
            Subtask Title
          </label>
          <input
            type="text"
            value={config.subtaskTitle}
            onChange={(e) => handleConfigChange('subtaskTitle', e.target.value)}
            className="
              w-full px-3 py-2 rounded-md text-xs text-[#d0d0e0]
              bg-white/[0.04] border border-white/[0.08]
              focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-white/10
              placeholder:text-[#80809a]/60
              transition-all
            "
            placeholder="What should this agent do?"
          />
        </div>

        {/* Model selector */}
        <div>
          <label className="block text-[10px] font-semibold text-[#80809a] uppercase tracking-wider mb-1.5">
            Model
          </label>
          <select
            value={config.model}
            onChange={(e) => handleConfigChange('model', e.target.value)}
            className="
              w-full px-3 py-2 rounded-md text-xs text-[#d0d0e0]
              bg-white/[0.04] border border-white/[0.08]
              focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-white/10
              transition-all appearance-none cursor-pointer
            "
            style={{
              backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`,
              backgroundPosition: 'right 8px center',
              backgroundRepeat: 'no-repeat',
              backgroundSize: '16px',
            }}
          >
            {modelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Permission mode */}
        <div>
          <label className="block text-[10px] font-semibold text-[#80809a] uppercase tracking-wider mb-1.5">
            Permission Mode
          </label>
          <div className="space-y-1.5">
            {PERMISSION_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`
                  flex items-start gap-2.5 p-2 rounded-md cursor-pointer
                  border transition-all duration-150
                  ${
                    config.permissionMode === opt.value
                      ? 'border-white/20 bg-white/[0.04]'
                      : 'border-transparent hover:bg-white/[0.02]'
                  }
                `}
              >
                <input
                  type="radio"
                  name="permissionMode"
                  value={opt.value}
                  checked={config.permissionMode === opt.value}
                  onChange={(e) =>
                    handleConfigChange(
                      'permissionMode',
                      e.target.value as AgentNodeConfig['permissionMode'],
                    )
                  }
                  className="mt-0.5 accent-purple-500"
                />
                <div>
                  <div className="text-xs font-medium text-[#d0d0e0]">{opt.label}</div>
                  <div className="text-[10px] text-[#80809a]">{opt.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Initial prompt */}
        <div>
          <label className="block text-[10px] font-semibold text-[#80809a] uppercase tracking-wider mb-1.5">
            Initial Prompt
          </label>
          <textarea
            value={config.initialPrompt}
            onChange={(e) => handleConfigChange('initialPrompt', e.target.value)}
            rows={6}
            className="
              w-full px-3 py-2 rounded-md text-xs text-[#d0d0e0]
              bg-white/[0.04] border border-white/[0.08]
              focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-white/10
              placeholder:text-[#80809a]/60
              transition-all resize-none
            "
            placeholder="Instructions for the agent..."
          />
        </div>

        {/* Delete button */}
        <div className="pt-2 border-t border-white/[0.06]">
          <button
            onClick={handleRemove}
            className="
              flex items-center gap-2 px-3 py-2 rounded-md w-full
              text-xs text-red-400 hover:text-red-300
              bg-red-500/[0.06] hover:bg-red-500/[0.12]
              border border-red-500/10 hover:border-red-500/20
              transition-all duration-150
            "
          >
            <Trash2 className="w-3.5 h-3.5" />
            Remove from canvas
          </button>
        </div>
      </div>

      {/* Accent bottom border */}
      <div className="h-0.5" style={{ backgroundColor: accentColor }} />
    </div>
  );
}
