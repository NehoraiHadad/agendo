import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { executions, tasks, sessions } from '@/lib/db/schema';
import { eq, sql, count } from 'drizzle-orm';

export const GET = withErrorBoundary(async () => {
  const [[runningResult], [todoResult], [sessionResult]] = await Promise.all([
    db
      .select({ count: count() })
      .from(executions)
      .where(sql`${executions.status} IN ('running', 'queued')`),
    db.select({ count: count() }).from(tasks).where(eq(tasks.status, 'todo')),
    db
      .select({ count: count() })
      .from(sessions)
      .where(sql`${sessions.status} IN ('active', 'awaiting_input')`),
  ]);

  return NextResponse.json({
    data: {
      runningExecutions: runningResult.count,
      todoTasks: todoResult.count,
      activeSessions: sessionResult.count,
    },
  });
});
