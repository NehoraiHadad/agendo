'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentNodeData } from '@/stores/team-canvas-store';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { useTeamCanvasStore } from '@/stores/team-canvas-store';

function AgentNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as AgentNodeData;
  const config = useTeamCanvasStore((s) => s.agentConfigs[id]);

  return (
    <div
      className={`
        group relative w-[220px] rounded-lg
        bg-white/[0.04] backdrop-blur-sm
        border transition-all duration-200
        ${selected ? 'border-white/30 shadow-lg' : 'border-white/[0.08] hover:border-white/20'}
      `}
      style={{
        borderLeftWidth: '3px',
        borderLeftColor: nodeData.accentColor,
        boxShadow: selected
          ? `0 0 20px ${nodeData.accentColor}20, 0 4px 12px rgba(0,0,0,0.3)`
          : '0 2px 8px rgba(0,0,0,0.2)',
      }}
    >
      {/* Target handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-white/20 !border-white/30 hover:!bg-white/40 transition-colors"
      />

      {/* Content */}
      <div className="px-3 py-2.5">
        {/* Header: Avatar + Name */}
        <div className="flex items-center gap-2 mb-2">
          <AgentAvatar name={nodeData.agentName} slug={nodeData.agentSlug} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-[#d0d0e0] truncate">{nodeData.agentName}</div>
            <div className="text-[10px] text-[#80809a] truncate">{nodeData.agentSlug}</div>
          </div>
        </div>

        {/* Model badge */}
        {config && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                backgroundColor: `${nodeData.accentColor}15`,
                color: nodeData.accentColor,
                border: `1px solid ${nodeData.accentColor}30`,
              }}
            >
              {config.model}
            </span>
            <span className="text-[10px] text-[#80809a] px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.06]">
              {config.permissionMode === 'bypassPermissions'
                ? 'auto'
                : config.permissionMode === 'acceptEdits'
                  ? 'edits'
                  : 'manual'}
            </span>
          </div>
        )}

        {/* Subtask title preview */}
        {config?.subtaskTitle && (
          <div className="mt-1.5 text-[10px] text-[#80809a] truncate">📋 {config.subtaskTitle}</div>
        )}
      </div>

      {/* Source handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-white/20 !border-white/30 hover:!bg-white/40 transition-colors"
      />
    </div>
  );
}

export const AgentNode = memo(AgentNodeComponent);
