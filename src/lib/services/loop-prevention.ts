import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { SafetyViolationError } from '@/lib/errors';
import { getWorkerConfigNumber } from './worker-config-service';

interface LoopGuardInput {
  parentExecutionId?: string;
  agentId: string;
}

interface LoopGuardResult {
  spawnDepth: number;
}

export async function checkLoopGuards(input: LoopGuardInput): Promise<LoopGuardResult> {
  // 1. Calculate spawn depth by walking the parent chain
  let spawnDepth = 0;
  if (input.parentExecutionId) {
    let currentId: string | null = input.parentExecutionId;
    const maxWalk = 20; // safety cap to prevent infinite loops
    let walked = 0;
    while (currentId && walked < maxWalk) {
      spawnDepth++;
      walked++;
      const [parent] = await db
        .select({ parentExecutionId: executions.parentExecutionId })
        .from(executions)
        .where(eq(executions.id, currentId))
        .limit(1);
      currentId = parent?.parentExecutionId ?? null;
    }

    const maxDepth = await getWorkerConfigNumber('max_spawn_depth', 3);
    if (spawnDepth >= maxDepth) {
      throw new SafetyViolationError(`Spawn depth ${spawnDepth} exceeds maximum ${maxDepth}`, {
        spawnDepth,
        maxDepth,
      });
    }
  }

  // 2. Check concurrent AI agent limit
  const [{ activeCount }] = await db
    .select({ activeCount: sql<number>`count(*)::int` })
    .from(executions)
    .where(sql`${executions.status} IN ('queued', 'running')`);

  const maxConcurrent = await getWorkerConfigNumber('max_concurrent_ai_agents', 3);
  if (activeCount >= maxConcurrent) {
    throw new SafetyViolationError(
      `Active execution count ${activeCount} would exceed limit ${maxConcurrent}`,
      { activeCount, maxConcurrent },
    );
  }

  return { spawnDepth };
}

const rateLimitMap = new Map<string, number[]>();

export async function checkTaskCreationRateLimit(agentId: string): Promise<void> {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window

  const timestamps = rateLimitMap.get(agentId) ?? [];
  // Prune old timestamps outside the window
  const recent = timestamps.filter((t) => now - t < windowMs);

  const maxRate = await getWorkerConfigNumber('max_tasks_per_agent_per_minute', 10);
  if (recent.length >= maxRate) {
    throw new SafetyViolationError(
      `Agent ${agentId} exceeded task creation rate limit (${maxRate}/min)`,
      { agentId, limit: maxRate, currentCount: recent.length },
    );
  }

  recent.push(now);
  rateLimitMap.set(agentId, recent);
}

/** Reset rate limit state — exported for testing only */
export function _resetRateLimits(): void {
  rateLimitMap.clear();
}
