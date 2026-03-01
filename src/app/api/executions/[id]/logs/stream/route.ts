import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogStreamHandler } from '@/lib/api/create-log-stream-handler';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<Record<string, string>> },
) {
  const { id } = await params;

  return createLogStreamHandler(req, id, {
    terminalStatuses: TERMINAL_STATUSES,
    notFoundMessage: `Execution ${id} not found`,
    async getRecord(executionId) {
      const [row] = await db
        .select({
          logFilePath: executions.logFilePath,
          status: executions.status,
          exitCode: executions.exitCode,
        })
        .from(executions)
        .where(eq(executions.id, executionId))
        .limit(1);
      return row ?? null;
    },
    async pollStatus(executionId) {
      const [row] = await db
        .select({ status: executions.status, exitCode: executions.exitCode })
        .from(executions)
        .where(eq(executions.id, executionId))
        .limit(1);
      return row ?? null;
    },
  });
}
