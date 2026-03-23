'use client';

import { memo, useId } from 'react';
import type { EdgeProps } from '@xyflow/react';
import { BaseEdge, getBezierPath, EdgeLabelRenderer } from '@xyflow/react';
import { useTeamMonitorStore } from '@/stores/team-monitor-store';
import type { EdgeAnimation } from '@/stores/team-monitor-store';

export interface MessageFlowEdgeData {
  fromAgentId: string;
  toAgentId: string;
  edgeId: string;
}

export interface MessageFlowEdgeType {
  id: string;
  source: string;
  target: string;
  type: 'messageFlow';
  data: MessageFlowEdgeData;
}

const MESSAGE_TYPE_COLORS: Record<EdgeAnimation['messageType'], string> = {
  status: '#3B82F6',
  correction: '#F97316',
  error: '#EF4444',
  complete: '#10B981',
  assignment: '#8B5CF6',
  other: '#6B7280',
};

const MESSAGE_TYPE_LABELS: Record<EdgeAnimation['messageType'], string> = {
  status: 'status',
  correction: 'correction',
  error: 'error',
  complete: 'complete',
  assignment: 'task',
  other: 'msg',
};

function MessageFlowEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const uid = useId();
  const gradientId = `edge-gradient-${uid}`;
  const edgeData = data as unknown as MessageFlowEdgeData | undefined;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetPosition,
    targetX,
    targetY,
  });

  const activeAnimation = useTeamMonitorStore((s) =>
    s.activeEdgeAnimations.find((a) => a.id === (edgeData?.edgeId ?? id)),
  );

  const animColor = activeAnimation ? MESSAGE_TYPE_COLORS[activeAnimation.messageType] : undefined;

  const isAnimating = !!activeAnimation;

  return (
    <>
      {/* SVG defs for gradient */}
      <defs>
        {isAnimating && animColor && (
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={sourceX}
            y1={sourceY}
            x2={targetX}
            y2={targetY}
          >
            <stop offset="0%" stopColor={animColor} stopOpacity={0.2} />
            <stop offset="50%" stopColor={animColor} stopOpacity={0.9} />
            <stop offset="100%" stopColor={animColor} stopOpacity={0.2} />
          </linearGradient>
        )}
      </defs>

      {/* Idle: faint dashed baseline */}
      {!isAnimating && (
        <path
          d={edgePath}
          fill="none"
          stroke="rgba(82,82,91,0.25)"
          strokeWidth={1}
          strokeDasharray="4 6"
        />
      )}

      {/* Active: glowing gradient stroke */}
      {isAnimating && animColor && (
        <>
          {/* Glow bloom layer */}
          <path
            d={edgePath}
            fill="none"
            stroke={animColor}
            strokeWidth={6}
            strokeOpacity={0.08}
            strokeLinecap="round"
          />
          {/* Main animated stroke */}
          <BaseEdge
            id={id}
            path={edgePath}
            style={{
              stroke: `url(#${gradientId})`,
              strokeWidth: 2,
              strokeLinecap: 'round',
              opacity: 1,
            }}
          />
        </>
      )}

      {/* Traveling particle */}
      {isAnimating && animColor && (
        <>
          {/* Glow trail */}
          <circle r={5} fill={animColor} opacity={0.18}>
            <animateMotion dur="1.4s" repeatCount="indefinite" path={edgePath} />
          </circle>
          {/* Core particle */}
          <circle r={3} fill={animColor} opacity={0.95}>
            <animateMotion dur="1.4s" repeatCount="indefinite" path={edgePath} />
          </circle>
          {/* Highlight sparkle */}
          <circle r={1.5} fill="white" opacity={0.7}>
            <animateMotion dur="1.4s" repeatCount="indefinite" path={edgePath} />
          </circle>
        </>
      )}

      {/* Message type label */}
      {activeAnimation && animColor && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'none',
            }}
          >
            <div
              className="flex items-center gap-1 rounded-full px-2 py-0.5 shadow-xl text-[8px] font-mono font-semibold tracking-wider uppercase"
              style={{
                background: `${animColor}14`,
                border: `1px solid ${animColor}40`,
                color: animColor,
                backdropFilter: 'blur(4px)',
              }}
            >
              <span
                className="size-1 rounded-full shrink-0"
                style={{ backgroundColor: animColor }}
              />
              {MESSAGE_TYPE_LABELS[activeAnimation.messageType]}
            </div>
            {activeAnimation.text && (
              <div
                className="mt-1 max-w-[140px] truncate rounded px-1.5 py-0.5 text-[8px] font-mono text-zinc-300 shadow-lg"
                style={{
                  background: 'rgba(10,10,20,0.9)',
                  border: '1px solid rgba(255,255,255,0.07)',
                }}
              >
                {activeAnimation.text}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const MessageFlowEdge = memo(MessageFlowEdgeInner);
MessageFlowEdge.displayName = 'MessageFlowEdge';
