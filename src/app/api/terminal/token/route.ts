import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createTerminalToken } from '@/terminal/auth';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { terminalJwtSecret } from '@/lib/config';
import { NotFoundError, ValidationError } from '@/lib/errors';

/**
 * POST /api/terminal/token
 *
 * Request body: { executionId: string }
 * Response:     { data: { token: string } }
 *
 * Issues a 5-minute JWT for connecting to the terminal WebSocket server.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const { executionId } = body;

  if (!executionId || typeof executionId !== 'string') {
    throw new ValidationError('executionId is required');
  }

  const [execution] = await db
    .select({
      tmuxSessionName: executions.tmuxSessionName,
      status: executions.status,
    })
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);

  if (!execution) {
    throw new NotFoundError('Execution', executionId);
  }

  if (!execution.tmuxSessionName) {
    throw new ValidationError('Execution does not have a tmux session');
  }

  if (!['running', 'cancelling'].includes(execution.status)) {
    throw new ValidationError(`Cannot attach terminal to execution in "${execution.status}" state`);
  }

  const token = createTerminalToken(
    {
      sessionName: execution.tmuxSessionName,
      userId: '00000000-0000-0000-0000-000000000001',
    },
    terminalJwtSecret,
  );

  return NextResponse.json({ data: { token } });
});
