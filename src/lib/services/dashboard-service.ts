import { eq, and, desc, sql, count, gte, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, executions, taskEvents, agents, workerHeartbeats } from '@/lib/db/schema';

// --- Types ---

export interface RecentEvent {
  id: number;
  taskId: string;
  eventType: string;
  actorType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface AgentHealthEntry {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  maxConcurrent: number;
  runningExecutions: number;
}

export interface ActiveExecution {
  id: string;
  taskId: string;
  agentId: string;
  agentName: string;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
}

export interface DashboardStats {
  taskCountsByStatus: Record<string, number>;
  totalTasks: number;
  activeExecutions: number;
  queuedExecutions: number;
  failedLast24h: number;
  recentEvents: RecentEvent[];
  agentHealth: AgentHealthEntry[];
  workerStatus: { isOnline: boolean; currentExecutions: number; lastSeenAt: Date } | null;
}

// --- Implementation ---

export async function getDashboardStats(): Promise<DashboardStats> {
  const [taskCounts, activeExecCounts, failedRow, recentEvents, agentRows, workerRow] =
    await Promise.all([
      // Task counts by status
      db.select({ status: tasks.status, count: count() }).from(tasks).groupBy(tasks.status),

      // Active execution counts grouped by status
      db
        .select({ status: executions.status, count: count() })
        .from(executions)
        .where(inArray(executions.status, ['running', 'queued', 'cancelling']))
        .groupBy(executions.status),

      // Failed last 24h
      db
        .select({ count: count() })
        .from(executions)
        .where(
          and(
            eq(executions.status, 'failed'),
            gte(executions.endedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
          ),
        ),

      // Recent 20 events
      db
        .select({
          id: taskEvents.id,
          taskId: taskEvents.taskId,
          eventType: taskEvents.eventType,
          actorType: taskEvents.actorType,
          payload: taskEvents.payload,
          createdAt: taskEvents.createdAt,
        })
        .from(taskEvents)
        .orderBy(desc(taskEvents.createdAt))
        .limit(20),

      // Agent health with running execution count
      db
        .select({
          id: agents.id,
          name: agents.name,
          slug: agents.slug,
          isActive: agents.isActive,
          maxConcurrent: agents.maxConcurrent,
          runningExecutions: sql<number>`(
            SELECT count(*)::int FROM executions
            WHERE executions.agent_id = agents.id
            AND executions.status IN ('running', 'queued')
          )`,
        })
        .from(agents)
        .where(eq(agents.toolType, 'ai-agent'))
        .orderBy(agents.name),

      // Worker status (latest heartbeat)
      db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt)).limit(1),
    ]);

  // Transform task counts to record
  const taskCountsByStatus: Record<string, number> = {};
  let totalTasks = 0;
  for (const row of taskCounts) {
    taskCountsByStatus[row.status] = row.count;
    totalTasks += row.count;
  }

  // Extract active/queued counts
  let activeExecutions = 0;
  let queuedExecutions = 0;
  for (const row of activeExecCounts) {
    if (row.status === 'running' || row.status === 'cancelling') {
      activeExecutions += row.count;
    }
    if (row.status === 'queued') {
      queuedExecutions = row.count;
    }
  }

  // Worker status
  let workerStatus: DashboardStats['workerStatus'] = null;
  if (workerRow.length > 0) {
    const worker = workerRow[0];
    const isOnline = worker.lastSeenAt.getTime() > Date.now() - 2 * 60 * 1000;
    workerStatus = {
      isOnline,
      currentExecutions: worker.currentExecutions,
      lastSeenAt: worker.lastSeenAt,
    };
  }

  return {
    taskCountsByStatus,
    totalTasks,
    activeExecutions,
    queuedExecutions,
    failedLast24h: failedRow[0]?.count ?? 0,
    recentEvents,
    agentHealth: agentRows,
    workerStatus,
  };
}

export async function getActiveExecutionsList(): Promise<ActiveExecution[]> {
  const rows = await db
    .select({
      id: executions.id,
      taskId: executions.taskId,
      agentId: executions.agentId,
      agentName: agents.name,
      status: executions.status,
      startedAt: executions.startedAt,
      createdAt: executions.createdAt,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .where(inArray(executions.status, ['running', 'queued', 'cancelling']))
    .orderBy(desc(executions.createdAt));

  return rows;
}
