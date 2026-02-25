'use client';

import { useState, useEffect } from 'react';

interface UsagePeriod {
  utilization: number;
  resets_at: string | null;
}

interface ClaudeUsage {
  subscriptionType: string | null;
  rateLimitTier: string | null;
  fiveHour: UsagePeriod | null;
  sevenDay: UsagePeriod | null;
  sevenDayOpus: UsagePeriod | null;
  sevenDaySonnet: UsagePeriod | null;
  sevenDayCowork: UsagePeriod | null;
  extraUsage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
}

function barColor(pct: number): string {
  if (pct >= 80) return 'oklch(0.65 0.22 25)';
  if (pct >= 50) return 'oklch(0.78 0.15 70)';
  return 'oklch(0.7 0.18 280)';
}

function formatReset(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = d.getTime() - now;
  if (diffMs <= 0) return 'resetting...';
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function UsageBar({ label, period }: { label: string; period: UsagePeriod }) {
  const pct = Math.min(100, period.utilization);
  const remaining = Math.max(0, 100 - pct);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/50">
          {label}
        </p>
        <p className="text-[10px] text-muted-foreground/40 tabular-nums">
          {period.resets_at && `resets in ${formatReset(period.resets_at)}`}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-white/[0.05] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: barColor(pct) }}
          />
        </div>
        <span
          className="text-sm font-mono font-bold tabular-nums w-[4ch] text-right"
          style={{ color: barColor(pct) }}
        >
          {remaining}%
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground/30 tabular-nums">{pct}% used</p>
    </div>
  );
}

export function ClaudeUsageCard() {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchUsage() {
      try {
        const res = await fetch('/api/usage/claude');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body?.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        const json = await res.json();
        setUsage(json.data);
        setError(null);
      } catch {
        setError('Failed to fetch usage');
      }
    }
    fetchUsage();
    const interval = setInterval(fetchUsage, 60_000); // refresh every minute
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.10_0_0)] p-5">
        <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/40 mb-2">
          Claude Usage
        </p>
        <p className="text-xs text-muted-foreground/40">{error}</p>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.10_0_0)] p-5 animate-pulse">
        <div className="h-3 w-24 bg-white/[0.05] rounded" />
        <div className="mt-4 space-y-4">
          <div className="h-2 bg-white/[0.03] rounded-full" />
          <div className="h-2 bg-white/[0.03] rounded-full" />
        </div>
      </div>
    );
  }

  const planLabel = usage.subscriptionType
    ? usage.subscriptionType.charAt(0).toUpperCase() + usage.subscriptionType.slice(1)
    : 'Unknown';

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.10_0_0)] p-5">
      <div className="flex items-baseline justify-between mb-4">
        <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/40">
          Claude Usage
        </p>
        <span className="rounded border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] font-mono text-muted-foreground/60">
          {planLabel}
        </span>
      </div>

      <div className="flex flex-col gap-4">
        {usage.fiveHour && <UsageBar label="5-Hour Window" period={usage.fiveHour} />}
        {usage.sevenDay && <UsageBar label="7-Day Window" period={usage.sevenDay} />}
        {usage.sevenDayOpus && usage.sevenDayOpus.utilization > 0 && (
          <UsageBar label="7-Day Opus" period={usage.sevenDayOpus} />
        )}
        {usage.sevenDaySonnet && usage.sevenDaySonnet.utilization > 0 && (
          <UsageBar label="7-Day Sonnet" period={usage.sevenDaySonnet} />
        )}
        {usage.sevenDayCowork && usage.sevenDayCowork.utilization > 0 && (
          <UsageBar label="7-Day Cowork" period={usage.sevenDayCowork} />
        )}
      </div>

      {usage.extraUsage && (
        <div className="mt-3 pt-3 border-t border-white/[0.05]">
          <p className="text-[10px] text-muted-foreground/40">
            Extra usage: {usage.extraUsage.is_enabled ? 'Enabled' : 'Disabled'}
            {usage.extraUsage.utilization != null && ` (${usage.extraUsage.utilization}% used)`}
          </p>
        </div>
      )}
    </div>
  );
}
