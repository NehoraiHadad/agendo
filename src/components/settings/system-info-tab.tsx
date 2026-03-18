'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Server, Cpu, HardDrive, Clock, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVersionCheck } from '@/hooks/use-version-check';
import { cn } from '@/lib/utils';

interface SystemStats {
  hostname: string;
  cpu: number;
  mem: number;
  swap: number;
  disk: number;
  diskRoot?: number;
  diskHome?: number;
  load: string;
  uptime: string;
  processes: Array<{ pid: string; name: string; mem_mb: number }>;
}

function resourceColor(pct: number): string {
  if (pct >= 85) return 'oklch(0.65 0.22 25)';
  if (pct >= 65) return 'oklch(0.72 0.18 60)';
  return 'oklch(0.65 0.15 140)';
}

function ResourceBar({ label, pct, icon: Icon }: { label: string; pct: number; icon: typeof Cpu }) {
  const color = resourceColor(pct);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-muted-foreground/40" />
          <span className="text-[12px] text-foreground/70">{label}</span>
        </div>
        <span className="text-[12px] font-mono font-medium" style={{ color }}>
          {pct}%
        </span>
      </div>
      <div className="h-1.5 w-full bg-white/[0.06] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/[0.03] last:border-0">
      <span className="text-[12px] text-muted-foreground/50">{label}</span>
      <span className="text-[12px] font-mono text-foreground/70">{value}</span>
    </div>
  );
}

export function SystemInfoTab() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { currentVersion } = useVersionCheck();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/system-stats');
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'System monitor unavailable');
        return;
      }
      const body = (await res.json()) as { data: SystemStats };
      setStats(body.data);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <Server className="h-8 w-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground/60">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!stats) return null;

  const nodeVersion = typeof process !== 'undefined' ? process.version : 'unknown';

  return (
    <div className="space-y-4">
      {/* Header with refresh */}
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading}
          className="h-7 text-[12px]"
        >
          <RefreshCw className={cn('h-3 w-3 mr-1.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Version & Runtime Info */}
        <div
          className="rounded-lg border border-white/[0.06] overflow-hidden"
          style={{ background: 'oklch(0.09 0 0)' }}
        >
          <div className="h-[2px] w-full" style={{ background: 'oklch(0.7 0.18 280 / 0.6)' }} />
          <div className="px-4 py-3 border-b border-white/[0.04]">
            <h3 className="text-[12px] font-semibold text-foreground/70 flex items-center gap-2">
              <Monitor className="h-3.5 w-3.5" />
              Application
            </h3>
          </div>
          <div className="px-4 py-1">
            <InfoRow label="Agendo version" value={`v${currentVersion}`} />
            <InfoRow label="Node.js" value={nodeVersion} />
            <InfoRow label="Hostname" value={stats.hostname} />
            <InfoRow label="Uptime" value={stats.uptime} />
            <InfoRow label="Load average" value={stats.load} />
          </div>
        </div>

        {/* Resource Usage */}
        <div
          className="rounded-lg border border-white/[0.06] overflow-hidden"
          style={{ background: 'oklch(0.09 0 0)' }}
        >
          <div className="h-[2px] w-full" style={{ background: 'oklch(0.65 0.15 140 / 0.6)' }} />
          <div className="px-4 py-3 border-b border-white/[0.04]">
            <h3 className="text-[12px] font-semibold text-foreground/70 flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5" />
              Resources
            </h3>
          </div>
          <div className="px-4 py-3 space-y-4">
            <ResourceBar label="CPU" pct={stats.cpu} icon={Cpu} />
            <ResourceBar label="Memory" pct={stats.mem} icon={Server} />
            <ResourceBar label="Swap" pct={stats.swap} icon={Server} />
            <ResourceBar label="Disk" pct={stats.disk} icon={HardDrive} />
          </div>
        </div>

        {/* PM2 Processes */}
        {stats.processes.length > 0 && (
          <div
            className="rounded-lg border border-white/[0.06] overflow-hidden sm:col-span-2"
            style={{ background: 'oklch(0.09 0 0)' }}
          >
            <div className="h-[2px] w-full" style={{ background: 'oklch(0.7 0.15 55 / 0.6)' }} />
            <div className="px-4 py-3 border-b border-white/[0.04]">
              <h3 className="text-[12px] font-semibold text-foreground/70 flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" />
                PM2 Processes
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-white/[0.04]">
                    <th className="text-left font-medium text-muted-foreground/40 px-4 py-2">
                      Name
                    </th>
                    <th className="text-left font-medium text-muted-foreground/40 px-4 py-2">
                      PID
                    </th>
                    <th className="text-right font-medium text-muted-foreground/40 px-4 py-2">
                      Memory
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.processes.map((proc) => (
                    <tr
                      key={proc.pid}
                      className="border-b border-white/[0.02] last:border-0 hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-2 font-mono text-foreground/70">{proc.name}</td>
                      <td className="px-4 py-2 font-mono text-muted-foreground/50">{proc.pid}</td>
                      <td className="px-4 py-2 font-mono text-right text-foreground/60">
                        {proc.mem_mb} MB
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
