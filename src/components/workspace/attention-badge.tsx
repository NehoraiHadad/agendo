'use client';

interface AttentionBadgeProps {
  show: boolean;
  count?: number;
}

export function AttentionBadge({ show, count }: AttentionBadgeProps) {
  if (!show) return null;

  return (
    <span
      className="relative inline-flex items-center justify-center"
      aria-label={count ? `${count} items need attention` : 'Needs attention'}
    >
      {/* Outer pulse ring */}
      <span
        className="absolute inset-0 rounded-full bg-amber-500/40"
        style={{ animation: 'attentionPulse 1.5s ease-out infinite' }}
      />
      {/* Inner badge */}
      <span
        className={`relative inline-flex items-center justify-center rounded-full bg-amber-500 text-black font-bold leading-none ${
          count !== undefined && count > 0
            ? 'min-w-[18px] h-[18px] px-1 text-[10px]'
            : 'w-2.5 h-2.5'
        }`}
      >
        {count !== undefined && count > 0 ? count : null}
      </span>

      <style>{`
        @keyframes attentionPulse {
          0% { transform: scale(1); opacity: 0.8; }
          70% { transform: scale(2.2); opacity: 0; }
          100% { transform: scale(2.2); opacity: 0; }
        }
      `}</style>
    </span>
  );
}
