'use client';

import { memo, useState, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TaskNodeData } from '@/stores/team-canvas-store';
import { useTeamCanvasStore } from '@/stores/team-canvas-store';

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  todo: { bg: 'bg-zinc-500/10', text: 'text-zinc-400', dot: 'bg-zinc-500' },
  in_progress: { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400' },
  done: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  blocked: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
};

function TaskNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as TaskNodeData;
  const updateTaskNode = useTeamCanvasStore((s) => s.updateTaskNode);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(nodeData.title);

  const statusStyle = STATUS_COLORS[nodeData.status] ?? STATUS_COLORS.todo;

  const handleDoubleClick = useCallback(() => {
    setIsEditing(true);
    setEditValue(nodeData.title);
  }, [nodeData.title]);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    if (editValue.trim() && editValue !== nodeData.title) {
      updateTaskNode(id, { title: editValue.trim(), label: editValue.trim() });
    }
  }, [editValue, nodeData.title, id, updateTaskNode]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        (e.target as HTMLInputElement).blur();
      }
      if (e.key === 'Escape') {
        setEditValue(nodeData.title);
        setIsEditing(false);
      }
    },
    [nodeData.title],
  );

  return (
    <div
      className={`
        group relative w-[200px] rounded-lg
        bg-white/[0.04] backdrop-blur-sm
        border border-dashed transition-all duration-200
        ${selected ? 'border-white/30 shadow-lg' : 'border-white/[0.12] hover:border-white/20'}
      `}
      style={{
        boxShadow: selected ? '0 0 16px rgba(255,255,255,0.05)' : '0 2px 8px rgba(0,0,0,0.2)',
      }}
    >
      {/* Target handle */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-white/20 !border-white/30 hover:!bg-white/40 transition-colors"
      />

      <div className="px-3 py-2.5">
        {/* Task icon + title */}
        <div className="flex items-start gap-2">
          <span className="text-sm mt-0.5">📋</span>
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <input
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                className="w-full text-xs font-medium text-[#d0d0e0] bg-transparent border-b border-white/20 outline-none px-0 py-0.5"
                autoFocus
              />
            ) : (
              <div
                className="text-xs font-medium text-[#d0d0e0] cursor-text truncate"
                onDoubleClick={handleDoubleClick}
                title="Double-click to edit"
              >
                {nodeData.title}
              </div>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dot}`} />
            {nodeData.status.replace('_', ' ')}
          </span>
        </div>
      </div>

      {/* Source handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-white/20 !border-white/30 hover:!bg-white/40 transition-colors"
      />
    </div>
  );
}

export const TaskNode = memo(TaskNodeComponent);
