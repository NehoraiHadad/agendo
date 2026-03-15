'use client';

import { cn } from '@/lib/utils';

export interface AgentStatusCardProps {
  name: string;
  slug: string;
  icon: string;
  found: boolean;
  version?: string;
  authHint?: string;
  animationDelay?: number;
}

export function AgentStatusCard({
  name,
  icon,
  found,
  version,
  authHint,
  animationDelay = 0,
}: AgentStatusCardProps) {
  return (
    <div
      className={cn(
        'relative flex items-start gap-4 rounded-lg border p-4',
        'bg-white/[0.02] backdrop-blur-sm',
        'opacity-0 translate-y-2',
        '[animation-fill-mode:forwards]',
        found
          ? 'border-l-[#00ff88] border-l-2 border-white/[0.06]'
          : 'border-white/[0.06] border-l-2 border-l-white/[0.15]',
      )}
      style={{
        animationName: 'agendoCardReveal',
        animationDuration: '0.4s',
        animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        animationDelay: `${animationDelay}ms`,
        animationFillMode: 'forwards',
      }}
    >
      {/* Scan line animation on mount */}
      <div
        className="absolute inset-0 rounded-lg overflow-hidden pointer-events-none"
        aria-hidden="true"
      >
        <div
          className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-[#00ff88]/30 to-transparent"
          style={{
            animationName: 'agendoScanLine',
            animationDuration: '0.8s',
            animationTimingFunction: 'ease-out',
            animationDelay: `${animationDelay + 100}ms`,
            animationFillMode: 'both',
            top: '-1px',
          }}
        />
      </div>

      {/* Icon */}
      <span className="text-4xl leading-none select-none" role="img" aria-label={name}>
        {icon}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p
          className="text-sm font-medium text-white/90 font-mono tracking-wide"
          style={{ fontFamily: 'var(--font-jetbrains), monospace' }}
        >
          {name}
        </p>

        {found ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-[#00ff88]/10 border border-[#00ff88]/25 px-2 py-0.5 text-[11px] font-medium text-[#00ff88]">
              <svg
                width="8"
                height="8"
                viewBox="0 0 8 8"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <path
                  d="M1.5 4L3 5.5L6.5 2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              ready
            </span>
            {version && (
              <span
                className="text-[11px] text-white/30 font-mono"
                style={{ fontFamily: 'var(--font-jetbrains), monospace' }}
              >
                {version}
              </span>
            )}
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] border border-white/[0.08] px-2 py-0.5 text-[11px] font-medium text-white/30">
              <svg
                width="8"
                height="8"
                viewBox="0 0 8 8"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <path
                  d="M2 2L6 6M6 2L2 6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              not installed
            </span>
            {authHint && <span className="text-[11px] text-white/25">{authHint}</span>}
          </div>
        )}
      </div>

      {/* Found indicator dot */}
      {found && (
        <div
          className="mt-1 h-2 w-2 rounded-full bg-[#00ff88] shrink-0"
          style={{
            boxShadow: '0 0 6px #00ff88, 0 0 12px #00ff8855',
          }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
