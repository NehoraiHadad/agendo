'use client';

import { useState, useEffect, useId } from 'react';

// ============================================================================
// Types
// ============================================================================

export type MessageEdgeColor =
  | 'blue' // standard message
  | 'orange' // task assignment
  | 'red' // error / permission denial
  | 'green' // task completion
  | 'purple' // tool call
  | 'yellow'; // awaiting input

interface Particle {
  /** Unique identifier for React key */
  id: string;
  /** CSS color value resolved from MessageEdgeColor */
  fill: string;
}

export interface AnimatedMessageEdgeProps {
  /**
   * SVG path `d` attribute string describing the edge route.
   * Provided by the React Flow edge component (MessageFlowEdge).
   */
  pathData: string;
  /** Semantic color category for the particle */
  color?: MessageEdgeColor;
  /** Duration of the particle travel animation (ms). Default: 1500 */
  durationMs?: number;
  /**
   * Increment this value to trigger a new particle.
   * Typically set to the running count of messages on this edge.
   * Each increment spawns one new particle.
   */
  messageCount?: number;
  /**
   * Maximum particles in flight simultaneously.
   * Older particles are kept until they complete. Default: 6
   */
  maxParticles?: number;
}

// ============================================================================
// Color map
// ============================================================================

const COLOR_MAP: Record<MessageEdgeColor, string> = {
  blue: '#3b82f6',
  orange: '#f97316',
  red: '#ef4444',
  green: '#22c55e',
  purple: '#a855f7',
  yellow: '#eab308',
};

// ============================================================================
// Component
// ============================================================================

/**
 * VISUALIZATION-ONLY: animated particle that travels along an SVG edge path.
 *
 * This is a pure-SVG component meant to be rendered **inside** a React Flow
 * custom edge's `<g>` element. The parent edge (MessageFlowEdge, owned by the
 * Monitor Mode agent) provides the path data; this component adds the motion.
 *
 * Animation technique:
 *   - Primary:  SVG <animateMotion> + <mpath> — native SVG, zero JS overhead
 *   - Opacity:  SVG <animate> fades in/out at 10% and 90% of the path
 *   - Glow:     SVG filter drop-shadow on the travelling circle
 *
 * Respects `prefers-reduced-motion` by reducing opacity change duration.
 *
 * @example
 * // Inside a React Flow EdgeProps render:
 * <g>
 *   <BaseEdge path={edgePath} ... />
 *   <AnimatedMessageEdge
 *     pathData={edgePath}
 *     color="blue"
 *     messageCount={messageCount}
 *   />
 * </g>
 */
export function AnimatedMessageEdge({
  pathData,
  color = 'blue',
  durationMs = 1500,
  messageCount = 0,
  maxParticles = 6,
}: AnimatedMessageEdgeProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  // Unique prefix for SVG IDs to avoid collisions when multiple edges mount
  const uid = useId();
  const filterId = `${uid}-glow`;
  const durationSec = (durationMs / 1000).toFixed(2);
  const fill = COLOR_MAP[color];

  // Spawn a new particle whenever messageCount increments
  useEffect(() => {
    if (messageCount <= 0 || !pathData) return;

    const particleId = `${uid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setParticles((prev) => {
      const updated = [...prev, { id: particleId, fill }];
      // Cap at maxParticles — drop the oldest if over limit
      return updated.length > maxParticles ? updated.slice(updated.length - maxParticles) : updated;
    });

    // Clean up particle after animation completes (+ small buffer)
    const timer = window.setTimeout(() => {
      setParticles((prev) => prev.filter((p) => p.id !== particleId));
    }, durationMs + 200);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount]);

  if (!pathData || particles.length === 0) return null;

  return (
    <g role="presentation" aria-hidden="true">
      {/* SVG filter for particle glow */}
      <defs>
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {particles.map((particle) => (
        <circle
          key={particle.id}
          r="5"
          fill={particle.fill}
          filter={`url(#${filterId})`}
          style={
            // Respect reduced-motion: skip opacity animation, keep motion
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? { opacity: 0.7 }
              : undefined
          }
        >
          {/* Fade in at 10%, stay visible until 90%, then fade out */}
          <animate
            attributeName="opacity"
            values="0;0;0.95;0.95;0"
            keyTimes="0;0.1;0.15;0.88;1"
            dur={`${durationSec}s`}
            fill="remove"
          />
          {/* Travel along the edge path */}
          <animateMotion
            dur={`${durationSec}s`}
            fill="remove"
            calcMode="spline"
            keySplines="0.25 0.46 0.45 0.94"
            keyTimes="0;1"
          >
            <mpath href={`#${uid}-path`} />
          </animateMotion>
        </circle>
      ))}

      {/*
        Hidden path element that animateMotion references via <mpath>.
        Must be in the same SVG document as the animating elements.
        We render it here rather than in <defs> so it is always co-located
        with the particles that reference it.
      */}
      <path id={`${uid}-path`} d={pathData} fill="none" stroke="none" />
    </g>
  );
}
