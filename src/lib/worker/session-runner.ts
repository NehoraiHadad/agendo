import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sessions, tasks, projects } from '@/lib/db/schema';
import { getSession } from '@/lib/services/session-service';
import { getAgentById } from '@/lib/services/agent-service';
import { getCapabilityById } from '@/lib/services/capability-service';
import { validateWorkingDir, validateBinary } from '@/lib/worker/safety';
import { SessionProcess } from '@/lib/worker/session-process';
import { selectAdapter } from '@/lib/worker/adapters/adapter-factory';

function interpolatePrompt(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_match, path: string) => {
    const parts = path.split('.');
    let value: unknown = args;
    for (const part of parts) {
      if (value === null || value === undefined || typeof value !== 'object') return '';
      value = (value as Record<string, unknown>)[part];
    }
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

export async function runSession(
  sessionId: string,
  workerId: string,
  resumeRef?: string,
): Promise<void> {
  const session = await getSession(sessionId);
  const agent = await getAgentById(session.agentId);
  const capability = await getCapabilityById(session.capabilityId);

  validateBinary(agent.binaryPath);

  // Load task for workingDir, env overrides, and prompt interpolation
  const [task] = await db
    .select({
      title: tasks.title,
      description: tasks.description,
      inputContext: tasks.inputContext,
      projectId: tasks.projectId,
    })
    .from(tasks)
    .where(eq(tasks.id, session.taskId))
    .limit(1);

  const project = task?.projectId
    ? await db
        .select()
        .from(projects)
        .where(eq(projects.id, task.projectId))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null;

  // WorkingDir priority: task.inputContext.workingDir > project.rootPath > agent.workingDir > /tmp
  const taskWorkingDir = (task?.inputContext as { workingDir?: string } | null)?.workingDir;
  const rawCwd = taskWorkingDir ?? project?.rootPath ?? agent.workingDir ?? '/tmp';
  const resolvedCwd = await validateWorkingDir(rawCwd);

  // Collect env overrides: project (less specific) then task (more specific).
  // These are merged on top of the base env in SessionProcess.start().
  const envOverrides: Record<string, string> = {};
  if (project?.envOverrides) {
    for (const [k, v] of Object.entries(project.envOverrides)) {
      envOverrides[k] = v;
    }
  }
  const taskEnv = (task?.inputContext as { envOverrides?: Record<string, string> } | null)?.envOverrides;
  if (taskEnv) {
    for (const [k, v] of Object.entries(taskEnv)) {
      envOverrides[k] = v;
    }
  }

  // Resolve the initial prompt
  let prompt = session.initialPrompt ?? '';
  if (!prompt && capability.promptTemplate) {
    if (task) {
      prompt = interpolatePrompt(capability.promptTemplate, {
        task_title: task.title,
        task_description: task.description ?? '',
        input_context: task.inputContext,
      });
    }
  }

  // Mark session as active (before starting so concurrency checks work)
  await db
    .update(sessions)
    .set({ status: 'active', startedAt: new Date(), workerId })
    .where(eq(sessions.id, sessionId));

  const adapter = selectAdapter(agent, capability);
  const sessionProc = new SessionProcess(session, adapter, workerId);
  await sessionProc.start(prompt, resumeRef ?? session.sessionRef ?? undefined, resolvedCwd, envOverrides);
  await sessionProc.waitForExit();
}
