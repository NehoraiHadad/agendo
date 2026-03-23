'use client';

import { useInsertionEffect, type ReactNode } from 'react';

// ============================================================================
// Types
// ============================================================================

export type AgentStatus = 'active' | 'awaiting_input' | 'idle' | 'done' | 'error';

export interface StatusRingProps {
  status: AgentStatus;
  children: ReactNode;
  className?: string;
  /**
   * Controls the ring thickness and outer glow spread.
   * sm = 1px ring, md = 2px ring, lg = 3px ring
   */
  size?: 'sm' | 'md' | 'lg';
}

// ============================================================================
// Keyframe CSS (injected once via useInsertionEffect)
// ============================================================================

const STYLE_ID = 'agendo-status-ring-styles';

const STATUS_RING_CSS = `
  /* ── Status Ring Base ── */
  .status-ring {
    position: relative;
    border-radius: inherit;
    transition: box-shadow 0.4s ease, border-color 0.4s ease;
  }
  .status-ring::before {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: inherit;
    border: 2px solid transparent;
    pointer-events: none;
    z-index: 1;
    transition: border-color 0.4s ease, box-shadow 0.4s ease;
  }
  .status-ring--sm::before { border-width: 1px; inset: -1px; }
  .status-ring--lg::before { border-width: 3px; inset: -3px; }

  /* ── Idle: no animation, muted gray ── */
  .status-ring--idle::before {
    border-color: rgba(128, 128, 154, 0.3);
  }

  /* ── Active: pulsing neon green glow ── */
  .status-ring--active::before {
    border-color: #39ff14;
    animation: status-ring-pulse-active 2s ease-in-out infinite;
  }
  @keyframes status-ring-pulse-active {
    0%, 100% { box-shadow: 0 0 4px 1px rgba(57, 255, 20, 0.4),
                            0 0 8px 2px rgba(57, 255, 20, 0.2); }
    50%       { box-shadow: 0 0 8px 3px rgba(57, 255, 20, 0.7),
                            0 0 16px 6px rgba(57, 255, 20, 0.3); }
  }

  /* ── Awaiting Input: steady amber with slow breathe ── */
  .status-ring--awaiting_input::before {
    border-color: #f8ff1f;
    animation: status-ring-breathe-amber 3s ease-in-out infinite;
  }
  @keyframes status-ring-breathe-amber {
    0%, 100% { box-shadow: 0 0 5px 1px rgba(248, 255, 31, 0.5),
                            0 0 10px 3px rgba(248, 255, 31, 0.2);
               opacity: 0.85; }
    50%       { box-shadow: 0 0 9px 3px rgba(248, 255, 31, 0.7),
                            0 0 18px 6px rgba(248, 255, 31, 0.3);
               opacity: 1; }
  }

  /* ── Done: brief green flash → solid blue ── */
  .status-ring--done::before {
    border-color: #00aaff;
    animation: status-ring-done-flash 0.6s ease-out forwards;
  }
  @keyframes status-ring-done-flash {
    0%   { border-color: #39ff14;
           box-shadow: 0 0 14px 5px rgba(57, 255, 20, 0.8); }
    60%  { border-color: #00aaff;
           box-shadow: 0 0 8px 3px rgba(0, 170, 255, 0.5); }
    100% { border-color: #00aaff;
           box-shadow: 0 0 4px 1px rgba(0, 170, 255, 0.2); }
  }

  /* ── Error: red pulse + shake ── */
  .status-ring--error::before {
    border-color: #ff3131;
    animation:
      status-ring-pulse-error 1.5s ease-in-out infinite,
      status-ring-shake 0.4s ease-in-out;
  }
  @keyframes status-ring-pulse-error {
    0%, 100% { box-shadow: 0 0 5px 1px rgba(255, 49, 49, 0.5),
                            0 0 10px 3px rgba(255, 49, 49, 0.2); }
    50%       { box-shadow: 0 0 10px 4px rgba(255, 49, 49, 0.8),
                            0 0 20px 8px rgba(255, 49, 49, 0.3); }
  }
  @keyframes status-ring-shake {
    0%          { transform: translateX(0); }
    20%         { transform: translateX(-3px); }
    40%         { transform: translateX(3px); }
    60%         { transform: translateX(-2px); }
    80%         { transform: translateX(2px); }
    100%        { transform: translateX(0); }
  }

  /* ── Reduced motion: disable animations, keep border colors ── */
  @media (prefers-reduced-motion: reduce) {
    .status-ring--active::before,
    .status-ring--awaiting_input::before,
    .status-ring--done::before,
    .status-ring--error::before {
      animation: none;
    }
    .status-ring--active::before       { box-shadow: 0 0 0 2px rgba(57, 255, 20, 0.6); }
    .status-ring--awaiting_input::before { box-shadow: 0 0 0 2px rgba(248, 255, 31, 0.6); }
    .status-ring--done::before         { box-shadow: 0 0 0 2px rgba(0, 170, 255, 0.6); }
    .status-ring--error::before        { box-shadow: 0 0 0 2px rgba(255, 49, 49, 0.6); }
  }
`;

// ============================================================================
// Hook: inject styles once
// ============================================================================

function useStatusRingStyles() {
  useInsertionEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = STATUS_RING_CSS;
    document.head.appendChild(el);
  }, []);
}

// ============================================================================
// Component
// ============================================================================

/**
 * Wraps any element with an animated status ring indicating agent state.
 *
 * Uses CSS-only animations (no JS library). Respects `prefers-reduced-motion`.
 *
 * @example
 * <StatusRing status="active">
 *   <AgentCard agent={agent} />
 * </StatusRing>
 */
export function StatusRing({ status, children, className = '', size = 'md' }: StatusRingProps) {
  useStatusRingStyles();

  const sizeClass = size === 'sm' ? 'status-ring--sm' : size === 'lg' ? 'status-ring--lg' : '';

  return (
    <div
      className={`status-ring status-ring--${status} ${sizeClass} ${className}`.trim()}
      data-status={status}
      aria-label={`Agent status: ${statusLabel(status)}`}
    >
      {children}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'awaiting_input':
      return 'Awaiting input';
    case 'idle':
      return 'Idle';
    case 'done':
      return 'Done';
    case 'error':
      return 'Error';
  }
}
