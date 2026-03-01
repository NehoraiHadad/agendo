import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';

const MONITOR_URL = 'http://localhost:9876';

export const GET = withErrorBoundary(async () => {
  const [statsRes, procsRes] = await Promise.all([
    fetch(`${MONITOR_URL}/stats`, { cache: 'no-store' }),
    fetch(`${MONITOR_URL}/processes`, { cache: 'no-store' }),
  ]);

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
