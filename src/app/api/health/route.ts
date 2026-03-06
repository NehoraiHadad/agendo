import { db } from '@/lib/db';
import { agents, workerHeartbeats } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status: {
    status: 'ok' | 'degraded' | 'error';
    db: 'connected' | 'error';
    worker: 'running' | 'stale' | 'unknown';
    agents: string[];
    version: string;
  } = {
    status: 'ok',
    db: 'error',
    worker: 'unknown',
    agents: [],
    version: process.env.npm_package_version ?? '0.1.0',
  };

  try {
    // Check DB + fetch agents and worker heartbeat in parallel
    const [agentRows, heartbeatRows] = await Promise.all([
      db.select({ name: agents.name }).from(agents).where(eq(agents.isActive, true)),
      db
        .select({ lastSeenAt: workerHeartbeats.lastSeenAt })
        .from(workerHeartbeats)
        .orderBy(desc(workerHeartbeats.lastSeenAt))
        .limit(1),
    ]);

    status.db = 'connected';
    status.agents = agentRows.map((a) => a.name);

    // Worker is "running" if heartbeat within last 60s
    if (heartbeatRows.length > 0) {
      const lastSeen = heartbeatRows[0].lastSeenAt;
      const ageMs = Date.now() - lastSeen.getTime();
      status.worker = ageMs < 60_000 ? 'running' : 'stale';
    }

    if (status.worker !== 'running') {
      status.status = 'degraded';
    }
  } catch {
    status.status = 'error';
  }

  const httpStatus = status.status === 'error' ? 503 : 200;
  return Response.json(status, { status: httpStatus });
}
