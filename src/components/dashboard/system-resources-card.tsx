'use client';

import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';

interface SystemStats {
  hostname: string;
  cpu: number;
  mem: number;
  swap: number;
  disk: number;
  diskRoot: number;
  diskHome: number;
  load: string;
  uptime: string;
  processes: Array<{ pid: string; name: string; mem_mb: number }>;
}

// ─── color helpers ──────────────────────────────────────────────────────────

function metricColor(pct: number): string {
  if (pct >= 85) return 'oklch(0.65 0.22 25)';
  if (pct >= 65) return 'oklch(0.78 0.15 70)';
  return 'oklch(0.72 0.18 145)';
}

function metricGlow(pct: number): string {
  if (pct >= 85) return 'drop-shadow(0 0 8px oklch(0.65 0.22 25 / 0.55))';
  if (pct >= 65) return 'drop-shadow(0 0 8px oklch(0.78 0.15 70 / 0.45))';
  return 'drop-shadow(0 0 8px oklch(0.72 0.18 145 / 0.35))';
}

// ─── SVG Arc Gauge ──────────────────────────────────────────────────────────

function ArcGauge({ pct, label, sub }: { pct: number; label: string; sub?: string }) {
  const r = 44;
  const cx = 56;
  const cy = 56;
  const circumference = 2 * Math.PI * r;
  // 270° arc (leave 90° gap at bottom)
  const arcFraction = 0.75;
  const trackLen = circumference * arcFraction;
  const filled = trackLen * (pct / 100);
  const offset = trackLen - filled;
  const color = metricColor(pct);
  const glow = metricGlow(pct);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative">
        <svg width="112" height="112" viewBox="0 0 112 112">
          {/* outer ring decoration */}
          <circle
            cx={cx}
            cy={cy}
            r={r + 10}
            fill="none"
            stroke="oklch(0.22 0 0)"
            strokeWidth="1"
            strokeDasharray="2 4"
            opacity="0.4"
          />
          {/* track */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="oklch(0.16 0 0)"
            strokeWidth="7"
            strokeDasharray={`${trackLen} ${circumference}`}
            strokeLinecap="round"
            transform={`rotate(135 ${cx} ${cy})`}
          />
          {/* fill */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="7"
            strokeDasharray={`${trackLen} ${circumference}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform={`rotate(135 ${cx} ${cy})`}
            style={{
              transition: 'stroke-dashoffset 0.8s cubic-bezier(.4,0,.2,1), stroke 0.3s ease',
              filter: glow,
            }}
          />
          {/* center value */}
          <text
            x={cx}
            y={cy - 4}
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily="'JetBrains Mono', 'Fira Code', monospace"
            fontSize="18"
            fontWeight="700"
            fill={color}
          >
            {pct}
          </text>
          <text
            x={cx}
            y={cy + 12}
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily="'JetBrains Mono', 'Fira Code', monospace"
            fontSize="9"
            fill="oklch(0.5 0 0)"
            letterSpacing="0.05em"
          >
            PCT
          </text>
        </svg>
      </div>
      <div className="text-center">
        <p
          className="text-[10px] font-bold uppercase tracking-[0.2em]"
          style={{ color: 'oklch(0.55 0 0)' }}
        >
          {label}
        </p>
        {sub && (
          <p className="text-[9px] tabular-nums mt-0.5" style={{ color: 'oklch(0.38 0 0)' }}>
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Load average display ────────────────────────────────────────────────────

function LoadSection({ load }: { load: string }) {
  const [one, five, fifteen] = load.split(' ').map(Number);
  const maxLoad = 4; // 4 vCPUs

  const bars = [
    { label: '1m', val: one },
    { label: '5m', val: five },
    { label: '15m', val: fifteen },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p
        className="text-[9px] font-bold uppercase tracking-[0.22em]"
        style={{ color: 'oklch(0.40 0 0)' }}
      >
        Load Avg
      </p>
      <div className="flex flex-col gap-2.5">
        {bars.map(({ label, val }) => {
          const pct = Math.min(100, (val / maxLoad) * 100);
          const color = metricColor(pct);
          return (
            <div key={label} className="flex items-center gap-3">
              <span
                className="w-6 text-[9px] font-mono tabular-nums shrink-0"
                style={{ color: 'oklch(0.38 0 0)' }}
              >
                {label}
              </span>
              <div
                className="flex-1 h-1 rounded-full overflow-hidden"
                style={{ background: 'oklch(0.15 0 0)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${pct}%`, background: color }}
                />
              </div>
              <span
                className="w-10 text-right text-[10px] font-mono tabular-nums shrink-0"
                style={{ color }}
              >
                {val?.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Process memory list ─────────────────────────────────────────────────────

function ProcessList({ processes }: { processes: SystemStats['processes'] }) {
  const top = processes.slice(0, 6);
  const maxMb = top[0]?.mem_mb ?? 1;

  return (
    <div className="flex flex-col gap-3">
      <p
        className="text-[9px] font-bold uppercase tracking-[0.22em]"
        style={{ color: 'oklch(0.40 0 0)' }}
      >
        Processes · RAM
      </p>
      <div className="flex flex-col gap-2">
        {top.map((proc, i) => {
          const barPct = (proc.mem_mb / maxMb) * 100;
          const isHeavy = proc.mem_mb > 1000;
          const memLabel =
            proc.mem_mb >= 1024 ? `${(proc.mem_mb / 1024).toFixed(1)}G` : `${proc.mem_mb}M`;
          // heat gradient: from violet at low end, through amber, to red at top
          const heatColor =
            i === 0
              ? 'oklch(0.65 0.22 25)'
              : i === 1
                ? 'oklch(0.68 0.20 35)'
                : i === 2
                  ? 'oklch(0.72 0.18 55)'
                  : 'oklch(0.70 0.14 280 / 0.7)';

          return (
            <div key={proc.pid} className="flex items-center gap-2.5">
              {/* rank */}
              <span
                className="shrink-0 w-3 text-[9px] font-mono tabular-nums text-right"
                style={{ color: 'oklch(0.32 0 0)' }}
              >
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between mb-1 gap-1">
                  <span
                    className="truncate text-[11px] font-medium"
                    style={{ color: isHeavy ? 'oklch(0.80 0 0)' : 'oklch(0.55 0 0)' }}
                  >
                    {proc.name}
                  </span>
                  <span
                    className="shrink-0 text-[10px] font-mono tabular-nums"
                    style={{ color: heatColor }}
                  >
                    {memLabel}
                  </span>
                </div>
                <div
                  className="h-[3px] rounded-full overflow-hidden"
                  style={{ background: 'oklch(0.15 0 0)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${barPct}%`,
                      background: `linear-gradient(90deg, ${heatColor}, ${heatColor.replace(')', ' / 0.5)')})`,
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div
      className="rounded-xl overflow-hidden animate-pulse"
      style={{
        background: 'oklch(0.09 0 0)',
        border: '1px solid oklch(0.16 0 0)',
      }}
    >
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.04]">
        <div className="h-2.5 w-32 rounded" style={{ background: 'oklch(0.15 0 0)' }} />
        <div className="h-2 w-20 rounded" style={{ background: 'oklch(0.14 0 0)' }} />
      </div>
      <div className="p-5">
        <div className="flex justify-around mb-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col items-center gap-3">
              <div className="h-28 w-28 rounded-full" style={{ background: 'oklch(0.13 0 0)' }} />
              <div className="h-2 w-12 rounded" style={{ background: 'oklch(0.15 0 0)' }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function SystemResourcesCard() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch('/api/system-stats');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body?.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        const json = await res.json();
        setStats(json.data);
        setRefreshedAt(new Date());
        setError(null);
      } catch {
        setError('Monitor unavailable');
      }
    }
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, []);

  function handleRefresh() {
    setSpinning(true);
    fetch('/api/system-stats')
      .then((r) => r.json())
      .then((json) => {
        setStats(json.data);
        setRefreshedAt(new Date());
        setError(null);
      })
      .catch(() => setError('Monitor unavailable'))
      .finally(() => setTimeout(() => setSpinning(false), 600));
  }

  if (!stats && !error) return <Skeleton />;

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'oklch(0.09 0 0)',
        border: '1px solid oklch(0.16 0 0)',
        boxShadow: '0 0 40px oklch(0 0 0 / 0.4)',
      }}
    >
      {/* ── Header ── */}
      <div
        className="flex items-center justify-between px-5 py-3"
        style={{ borderBottom: '1px solid oklch(0.14 0 0)' }}
      >
        <div className="flex items-center gap-3">
          <p
            className="text-[9px] font-bold uppercase tracking-[0.25em]"
            style={{ color: 'oklch(0.40 0 0)' }}
          >
            System Resources
          </p>
          {stats && (
            <span
              className="rounded px-1.5 py-0.5 text-[9px] font-mono"
              style={{
                background: 'oklch(0.14 0 0)',
                border: '1px solid oklch(0.20 0 0)',
                color: 'oklch(0.45 0 0)',
              }}
            >
              {stats.hostname}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {stats && (
            <span className="text-[9px] font-mono" style={{ color: 'oklch(0.30 0 0)' }}>
              up {stats.uptime}
            </span>
          )}
          {refreshedAt && (
            <span className="text-[9px] font-mono" style={{ color: 'oklch(0.28 0 0)' }}>
              {refreshedAt.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          )}
          <button
            onClick={handleRefresh}
            className="p-1 rounded transition-colors hover:bg-white/[0.04]"
            style={{ color: 'oklch(0.32 0 0)' }}
            title="Refresh"
          >
            <RefreshCw
              className="h-3 w-3"
              style={{
                animation: spinning ? 'spin 0.6s linear' : undefined,
              }}
            />
          </button>
        </div>
      </div>

      {error ? (
        <div className="p-5">
          <p className="text-xs" style={{ color: 'oklch(0.55 0.15 25)' }}>
            {error}
          </p>
        </div>
      ) : stats ? (
        <>
          {/* ── Gauges row ── */}
          <div
            className="grid grid-cols-2 sm:grid-cols-4 gap-0 divide-x divide-white/[0.06]"
            style={{ borderBottom: '1px solid oklch(0.14 0 0)' }}
          >
            <div className="flex items-center justify-center py-6">
              <ArcGauge pct={stats.cpu} label="CPU" />
            </div>
            <div className="flex items-center justify-center py-6">
              <ArcGauge pct={stats.mem} label="RAM" />
            </div>
            <div className="flex items-center justify-center py-6">
              <ArcGauge pct={stats.swap} label="Swap" />
            </div>
            <div className="flex items-center justify-center py-6">
              <ArcGauge pct={stats.diskRoot} label="Disk" sub={`/home ${stats.diskHome}%`} />
            </div>
          </div>

          {/* ── Bottom: load + processes ── */}
          <div className="grid gap-0 sm:grid-cols-2 divide-x divide-white/[0.06]">
            <div className="p-5">
              <LoadSection load={stats.load} />
            </div>
            <div className="p-5" style={{ borderLeft: '1px solid oklch(0.14 0 0)' }}>
              <ProcessList processes={stats.processes} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
