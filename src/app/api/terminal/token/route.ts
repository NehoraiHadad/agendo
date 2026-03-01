import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createTerminalToken } from '@/terminal/auth';
import { db } from '@/lib/db';
import { executions, sessions, agents, tasks, projects } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { terminalJwtSecret } from '@/lib/config';
import { NotFoundError, ValidationError } from '@/lib/errors';
import type { TaskInputContext } from '@/lib/types';

/**
 * POST /api/terminal/token
 *
 * Request body: { executionId: string } OR { sessionId: string }
 * Response:     { data: { token: string } }
 *
 * Issues a 5-minute JWT for connecting to the terminal WebSocket server.
 * - executionId: attaches to an existing tmux session (attach mode)
 * - sessionId: opens a plain bash shell in the session's working directory (shell mode)
 */

function buildResumeHint(agentSlug: string, sessionRef: string | null): string {
  if (!sessionRef) return 'No session ref available — start a new session with the agent CLI.';
  const slug = agentSlug.toLowerCase();
  if (slug.includes('claude')) return `Resume: claude --resume ${sessionRef}`;
  if (slug.includes('codex')) return `Resume: codex (session ID: ${sessionRef})`;
  if (slug.includes('gemini')) return `Resume: gemini (session ref: ${sessionRef})`;
  return `Session ref: ${sessionRef}`;
}

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = (await req.json()) as { executionId?: string; sessionId?: string };
  const { executionId, sessionId } = body;

  // --- Branch: session shell mode ---
  if (sessionId) {
    if (typeof sessionId !== 'string') {
      throw new ValidationError('sessionId must be a string');
    }

    const [row] = await db
      .select({
        sessionRef: sessions.sessionRef,
        sessionProjectId: sessions.projectId,
        agentSlug: agents.slug,
        taskInputContext: tasks.inputContext,
        projectRootPath: projects.rootPath,
        status: sessions.status,
      })
      .from(sessions)
      .innerJoin(agents, eq(agents.id, sessions.agentId))
      .leftJoin(tasks, eq(tasks.id, sessions.taskId))
      .leftJoin(projects, eq(projects.id, sessions.projectId))
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Session', sessionId);
    }

    const inputContext = row.taskInputContext as TaskInputContext | null;
    const cwd = inputContext?.workingDir ?? row.projectRootPath ?? process.env.HOME ?? '/tmp';
    const hint = buildResumeHint(row.agentSlug, row.sessionRef);

    const token = createTerminalToken(
      {
        sessionName: `shell-${sessionId}`,
        userId: '00000000-0000-0000-0000-000000000001',
        mode: 'shell',
        cwd,
        initialHint: hint,
      },
      terminalJwtSecret,
    );

    return NextResponse.json({ data: { token } });
  }

  // --- Branch: execution tmux attach mode ---
  if (!executionId || typeof executionId !== 'string') {
    throw new ValidationError('executionId or sessionId is required');
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
      mode: 'attach',
    },
    terminalJwtSecret,
  );

  return NextResponse.json({ data: { token } });
});
