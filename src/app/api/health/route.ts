import { db } from '@/lib/db';
import { agents, workerHeartbeats } from '@/lib/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

const startTime = Date.now();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const detailed = url.searchParams.get('detailed') === 'true';

  const version = process.env.npm_package_version ?? '0.1.0';
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
      db.execute(sql`
        SELECT state, count(*)::int as count
        FROM pgboss.job
        WHERE name IN ('run-session', 'execute-capability')
          AND state IN ('active', 'created')
        GROUP BY state
      `),
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

    const rows = queueRows.rows as Array<{ state: string; count: number }>;
    const active = rows.find((r) => r.state === 'active');
    const queued = rows.find((r) => r.state === 'created');
    queue = {
      status: 'ok',
      activeJobs: active?.count ?? 0,
      queuedJobs: queued?.count ?? 0,
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
