import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createTerminalToken } from '@/terminal/auth';
import { db } from '@/lib/db';
import { sessions, agents, tasks, projects } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { terminalJwtSecret } from '@/lib/config';
import { NotFoundError, ValidationError } from '@/lib/errors';
import type { TaskInputContext } from '@/lib/types';

/**
 * POST /api/terminal/token
 *
 * Request body: { sessionId: string }
 * Response:     { data: { token: string } }
 *
 * Issues a 5-minute JWT for connecting to the terminal WebSocket server.
 * Opens a plain bash shell in the session's working directory.
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
  const body = (await req.json()) as { sessionId?: string };
  const { sessionId } = body;

  if (!sessionId || typeof sessionId !== 'string') {
    throw new ValidationError('sessionId is required');
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
});
