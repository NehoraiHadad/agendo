import { cn } from '@/lib/utils';
import type { DashboardStats } from '@/lib/services/dashboard-service';

interface StatsGridProps {
  stats: DashboardStats;
}

interface Metric {
  title: string;
  getValue: (stats: DashboardStats) => number;
  color: string;
  dimColor: string;
  isLive: boolean;
  isAlert: boolean;
}

const METRICS: Metric[] = [
  {
    title: 'Total Tasks',
    getValue: (s) => s.totalTasks,
    color: 'oklch(0.68 0.14 235)',
    dimColor: 'oklch(0.68 0.14 235 / 0.12)',
    isLive: false,
    isAlert: false,
  },
  {
    title: 'Todo',
    getValue: (s) => s.taskCountsByStatus['todo'] ?? 0,
    color: 'oklch(0.72 0.18 145)',
    dimColor: 'oklch(0.72 0.18 145 / 0.12)',
    isLive: false,
    isAlert: false,
  },
  {
    title: 'In Progress',
    getValue: (s) => s.taskCountsByStatus['in_progress'] ?? 0,
    color: 'oklch(0.78 0.15 70)',
    dimColor: 'oklch(0.78 0.15 70 / 0.12)',
    isLive: true,
    isAlert: false,
  },
  {
    title: 'Done',
    getValue: (s) => s.taskCountsByStatus['done'] ?? 0,
    color: 'oklch(0.62 0.22 22)',
    dimColor: 'oklch(0.62 0.22 22 / 0.12)',
    isLive: false,
    isAlert: false,
  },
];

export function StatsGrid({ stats }: StatsGridProps) {
  const allValues = METRICS.map((m) => m.getValue(stats));
  const maxValue = Math.max(...allValues, 1);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {METRICS.map((m) => {
        const value = m.getValue(stats);
        const pct = (value / maxValue) * 100;
        const isActive = m.isLive && value > 0;
        const isAlert = m.isAlert && value > 0;
        const useAccent = isActive || isAlert;

        return (
          <div
            key={m.title}
            className={cn(
              'group relative overflow-hidden rounded-xl border border-white/[0.06] bg-[oklch(0.10_0_0)]',
              'px-5 pt-4 pb-3 transition-colors hover:bg-[oklch(0.115_0_0)] cursor-default',
              isActive && 'border-l-2',
              isAlert && value > 0 && 'border-l-2',
            )}
            style={
              useAccent
                ? {
                    borderLeftColor: m.color,
                    boxShadow: `0 0 20px ${m.dimColor}`,
                  }
                : { borderLeftColor: 'oklch(0.25 0 0)' }
            }
          >
            {/* Label */}
            <p className="mb-3 text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/40 select-none">
              {m.title}
            </p>

            {/* Value */}
            <p
              className="font-mono text-5xl font-bold tabular-nums leading-none"
              style={{ color: useAccent ? m.color : 'oklch(0.88 0 0)' }}
            >
              {value}
            </p>

            {/* Bottom progress bar — shows relative magnitude across all metrics */}
            <div className="mt-4 h-px bg-white/[0.05] overflow-hidden rounded-full">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${pct}%`,
                  background: `linear-gradient(90deg, ${m.color} 0%, ${m.dimColor} 100%)`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
