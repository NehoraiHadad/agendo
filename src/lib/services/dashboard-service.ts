import { eq, desc, count } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, taskEvents, agents, workerHeartbeats } from '@/lib/db/schema';

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
}

export interface DashboardStats {
  taskCountsByStatus: Record<string, number>;
  totalTasks: number;
  recentEvents: RecentEvent[];
  agentHealth: AgentHealthEntry[];
  workerStatus: { isOnline: boolean; lastSeenAt: Date } | null;
}

// --- Implementation ---

export async function getDashboardStats(): Promise<DashboardStats> {
  const [taskCounts, recentEvents, agentRows, workerRow] = await Promise.all([
    // Task counts by status
    db.select({ status: tasks.status, count: count() }).from(tasks).groupBy(tasks.status),

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

    // Agent health
    db
      .select({
        id: agents.id,
        name: agents.name,
        slug: agents.slug,
        isActive: agents.isActive,
        maxConcurrent: agents.maxConcurrent,
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

  // Worker status
  let workerStatus: DashboardStats['workerStatus'] = null;
  if (workerRow.length > 0) {
    const worker = workerRow[0];
    const isOnline = worker.lastSeenAt.getTime() > Date.now() - 2 * 60 * 1000;
    workerStatus = {
      isOnline,
      lastSeenAt: worker.lastSeenAt,
    };
  }

  return {
    taskCountsByStatus,
    totalTasks,
    recentEvents,
    agentHealth: agentRows,
    workerStatus,
  };
}
