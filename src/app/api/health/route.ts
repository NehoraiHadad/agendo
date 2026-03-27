import { db } from '@/lib/db';
import { agents, sessions, workerHeartbeats } from '@/lib/db/schema';
import { eq, desc, sql, inArray } from 'drizzle-orm';
import { statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from '@/lib/config';
import { getCurrentVersion } from '@/lib/version';
import { checkForUpdates } from '@/lib/services/version-service';

export const dynamic = 'force-dynamic';

const startTime = Date.now();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const detailed = url.searchParams.get('detailed') === 'true';

  const version = getCurrentVersion();
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  if (!detailed) {
    // Basic probe: quick DB ping only (<100ms target)
    let status: 'ok' | 'degraded' | 'error' = 'ok';
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      status = 'error';
      return Response.json({ status, version, uptime }, { status: 503 });
    }
    return Response.json({ status, version, uptime });
  }

  // Detailed mode: run all checks in parallel
  let topStatus: 'ok' | 'degraded' | 'error' = 'ok';

  interface DatabaseCheck {
    status: 'ok' | 'error';
    latencyMs: number;
  }
  interface WorkerCheck {
    status: 'ok' | 'stale' | 'unknown';
    lastSeenAt: string | null;
    workerId: string | null;
  }
  interface AgentsCheck {
    discovered: string[];
    count: number;
  }
  interface QueueCheck {
    status: 'ok' | 'error';
    activeJobs: number;
    queuedJobs: number;
  }
  interface DiskCheck {
    status: 'ok' | 'low' | 'error';
    freeGB: number;
    logDir: string;
  }
  interface McpCheck {
    serverPath: string | null;
    exists: boolean;
  }

  let database: DatabaseCheck | undefined;
  let worker: WorkerCheck | undefined;
  let agentsCheck: AgentsCheck | undefined;
  let queue: QueueCheck | undefined;
  let disk: DiskCheck | undefined;

  const dbStart = Date.now();

  try {
    const [agentRows, heartbeatRows, queueRows] = await Promise.all([
      db.select({ name: agents.name }).from(agents).where(eq(agents.isActive, true)),
      db
        .select({
          workerId: workerHeartbeats.workerId,
          lastSeenAt: workerHeartbeats.lastSeenAt,
        })
        .from(workerHeartbeats)
        .orderBy(desc(workerHeartbeats.lastSeenAt))
        .limit(1),
      db
        .select({ status: sessions.status, count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(inArray(sessions.status, ['active', 'awaiting_input']))
        .groupBy(sessions.status),
    ]);

    database = { status: 'ok', latencyMs: Date.now() - dbStart };

    agentsCheck = {
      discovered: agentRows.map((a) => a.name),
      count: agentRows.length,
    };

    if (heartbeatRows.length > 0) {
      const hb = heartbeatRows[0];
      const ageMs = Date.now() - hb.lastSeenAt.getTime();
      worker = {
        status: ageMs < 60_000 ? 'ok' : 'stale',
        lastSeenAt: hb.lastSeenAt.toISOString(),
        workerId: hb.workerId,
      };
    } else {
      worker = { status: 'unknown', lastSeenAt: null, workerId: null };
    }

    const activeRow = queueRows.find((r) => r.status === 'active');
    const awaitingRow = queueRows.find((r) => r.status === 'awaiting_input');
    queue = {
      status: 'ok',
      activeJobs: (activeRow?.count ?? 0) + (awaitingRow?.count ?? 0),
      queuedJobs: 0,
    };
  } catch {
    database = { status: 'error', latencyMs: Date.now() - dbStart };
    topStatus = 'error';
  }

  // Disk check (non-blocking)
  try {
    const stats = await statfs(config.LOG_DIR);
    const freeGB = (stats.bavail * stats.bsize) / 1024 ** 3;
    disk = {
      status: freeGB >= 5 ? 'ok' : 'low',
      freeGB: Math.round(freeGB * 10) / 10,
      logDir: config.LOG_DIR,
    };
  } catch {
    disk = { status: 'error', freeGB: 0, logDir: config.LOG_DIR };
  }

  // MCP server file existence
  const mcpPath = config.MCP_SERVER_PATH ?? null;
  const mcp: McpCheck = {
    serverPath: mcpPath,
    exists: mcpPath ? existsSync(mcpPath) : false,
  };

  // Version update check (uses cache, non-blocking)
  let update: { available: boolean; latestVersion: string | null } | undefined;
  try {
    const versionInfo = await checkForUpdates();
    update = {
      available: versionInfo.updateAvailable,
      latestVersion: versionInfo.latestVersion,
    };
  } catch {
    // Non-critical — skip update check
  }

  // Derive top-level status
  if (database?.status === 'error') {
    topStatus = 'error';
  } else if (worker?.status !== 'ok' || disk?.status === 'low') {
    topStatus = 'degraded';
  }

  const httpStatus = topStatus === 'error' ? 503 : 200;
  return Response.json(
    {
      status: topStatus,
      version,
      uptime,
      update,
      checks: {
        database,
        worker,
        agents: agentsCheck,
        queue,
        disk,
        mcp,
      },
    },
    { status: httpStatus },
  );
}
