import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects, tasks } from '@/lib/db/schema';
import { getAgentById } from '@/lib/services/agent-service';
import { getSession } from '@/lib/services/session-service';
import type { Agent, Project, Session, TaskInputContext } from '@/lib/types';
import { validateWorkingDir } from '@/lib/worker/safety';
import { isDemoMode } from '@/lib/demo/flag';

interface SessionTaskContext {
  title: string;
  description: string | null;
  inputContext: TaskInputContext | null;
  projectId: string | null;
}

export interface SessionRuntimeContext {
  session: Session;
  agent: Agent;
  task: SessionTaskContext | null;
  project: Project | null;
  resolvedProjectId: string | null;
  cwd: string;
  envOverrides: Record<string, string>;
}

export async function resolveSessionRuntimeContext(
  sessionId: string,
): Promise<SessionRuntimeContext> {
  if (isDemoMode()) {
    const demo = await import('./session-runtime-context.demo');
    return demo.resolveSessionRuntimeContext(sessionId);
  }
  const session = await getSession(sessionId);
  const agent = await getAgentById(session.agentId);

  const task = session.taskId
    ? await db
        .select({
          title: tasks.title,
          description: tasks.description,
          inputContext: tasks.inputContext,
          projectId: tasks.projectId,
        })
        .from(tasks)
        .where(eq(tasks.id, session.taskId))
        .limit(1)
        .then((rows) => {
          const row = rows[0];
          if (!row) return null;
          return {
            title: row.title,
            description: row.description,
            inputContext: (row.inputContext as TaskInputContext | null) ?? null,
            projectId: row.projectId,
          };
        })
    : null;

  const resolvedProjectId = session.projectId ?? task?.projectId ?? null;
  const project = resolvedProjectId
    ? await db
        .select()
        .from(projects)
        .where(eq(projects.id, resolvedProjectId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;

  const rawCwd = task?.inputContext?.workingDir ?? project?.rootPath ?? agent.workingDir ?? '/tmp';
  const cwd = await validateWorkingDir(rawCwd);

  const envOverrides: Record<string, string> = {};
  if (project?.envOverrides) {
    for (const [key, value] of Object.entries(project.envOverrides)) {
      envOverrides[key] = value;
    }
  }
  if (task?.inputContext?.envOverrides) {
    for (const [key, value] of Object.entries(task.inputContext.envOverrides)) {
      envOverrides[key] = value;
    }
  }
  if (resolvedProjectId) {
    envOverrides['AGENDO_PROJECT_ID'] = resolvedProjectId;
  }

  return { session, agent, task, project, resolvedProjectId, cwd, envOverrides };
}
