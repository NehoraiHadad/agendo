import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { isDemoMode } from '@/lib/demo/flag';

const MONITOR_URL = process.env.MONITOR_URL ?? 'http://localhost:9876';

export const GET = withErrorBoundary(async () => {
  if (isDemoMode()) {
    return NextResponse.json({
      data: {
        hostname: 'demo-host',
        cpu: 12,
        mem: 34,
        swap: 0,
        disk: 27,
        diskRoot: 27,
        diskHome: 41,
        load: '0.42 0.38 0.30',
        uptime: '3 days',
        processes: [
          { pid: '1001', name: 'agendo', mem_mb: 184 },
          { pid: '1002', name: 'agendo-worker', mem_mb: 92 },
          { pid: '1003', name: 'agendo-terminal', mem_mb: 38 },
        ],
      },
    });
  }

  let statsRes: Response;
  let procsRes: Response;

  try {
    [statsRes, procsRes] = await Promise.all([
      fetch(`${MONITOR_URL}/stats`, { cache: 'no-store' }),
      fetch(`${MONITOR_URL}/processes`, { cache: 'no-store' }),
    ]);
  } catch {
    return NextResponse.json(
      { error: { code: 'MONITOR_UNAVAILABLE', message: 'Server monitor API unavailable' } },
      { status: 503 },
    );
  }

  if (!statsRes.ok) {
    return NextResponse.json(
      { error: { code: 'MONITOR_UNAVAILABLE', message: 'Server monitor API unavailable' } },
      { status: 503 },
    );
  }

  const stats = await statsRes.json();
  const procs = procsRes.ok ? await procsRes.json() : { processes: [] };

  return NextResponse.json({
    data: {
      hostname: stats.hostname as string,
      cpu: stats.cpu as number,
      mem: stats.mem as number,
      swap: stats.swap as number,
      disk: stats.disk as number,
      diskRoot: stats.disk_root as number,
      diskHome: stats.disk_home as number,
      load: stats.load as string,
      uptime: stats.uptime as string,
      processes: procs.processes as Array<{ pid: string; name: string; mem_mb: number }>,
    },
  });
});
