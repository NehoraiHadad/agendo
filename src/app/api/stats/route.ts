import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { tasks, sessions } from '@/lib/db/schema';
import { eq, sql, count } from 'drizzle-orm';

export const GET = withErrorBoundary(async () => {
  const [[todoResult], [sessionResult]] = await Promise.all([
    db.select({ count: count() }).from(tasks).where(eq(tasks.status, 'todo')),
    db
      .select({ count: count() })
      .from(sessions)
      .where(sql`${sessions.status} IN ('active', 'awaiting_input')`),
  ]);

  return NextResponse.json({
    data: {
      todoTasks: todoResult.count,
      activeSessions: sessionResult.count,
    },
  });
});
