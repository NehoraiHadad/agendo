import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sessions, tasks, projects } from '@/lib/db/schema';
import { config } from '@/lib/config';
import { getSession } from '@/lib/services/session-service';
import { getAgentById } from '@/lib/services/agent-service';
import { getCapabilityById } from '@/lib/services/capability-service';
import { validateWorkingDir, validateBinary } from '@/lib/worker/safety';
import { SessionProcess } from '@/lib/worker/session-process';
import { selectAdapter } from '@/lib/worker/adapters/adapter-factory';
import { generateSessionMcpConfig, generateGeminiAcpMcpServers } from '@/lib/mcp/config-templates';
import { listTaskEvents } from '@/lib/services/task-event-service';
import type { AcpMcpServer } from '@/lib/worker/adapters/types';

/**
 * Live session processes that have released their pg-boss slot (reached
 * awaiting_input) but whose underlying agent process is still running.
 * Keyed by sessionId. Used by shutdown to gracefully terminate them.
 */
export const liveSessionProcs = new Map<string, SessionProcess>();

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
  const taskEnv = (task?.inputContext as { envOverrides?: Record<string, string> } | null)
    ?.envOverrides;
  if (taskEnv) {
    for (const [k, v] of Object.entries(taskEnv)) {
      envOverrides[k] = v;
    }
  }

  // Propagate projectId into the child env so hooks can read it without MCP.
  if (task?.projectId) {
    envOverrides['AGENDO_PROJECT_ID'] = task.projectId;
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

  // Determine the binary basename so we can gate claude-only features below.
  const binaryName = agent.binaryPath.split('/').pop()?.toLowerCase() ?? '';

  // Phase A: Generate a session-scoped MCP config file when the agent has MCP
  // enabled and a server path is configured. The file embeds the session
  // identity so the MCP server can associate tool calls with this session/task.
  // Only claude supports --mcp-config; skip for codex, gemini, etc.
  let mcpConfigPath: string | undefined;
  if (agent.mcpEnabled && config.MCP_SERVER_PATH && binaryName === 'claude') {
    const identity = {
      sessionId,
      taskId: session.taskId,
      agentId: session.agentId,
      projectId: task?.projectId ?? null,
    };
    const mcpConfig = generateSessionMcpConfig(config.MCP_SERVER_PATH, identity);
    mcpConfigPath = `/tmp/agendo-mcp-${sessionId}.json`;
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    console.log(`[session-runner] Claude MCP config written for session ${sessionId}`);
  }

  // Phase A2: For Gemini, inject MCP servers via the ACP session/new request.
  let mcpServers: AcpMcpServer[] | undefined;
  if (agent.mcpEnabled && config.MCP_SERVER_PATH && binaryName === 'gemini') {
    const identity = {
      sessionId,
      taskId: session.taskId,
      agentId: session.agentId,
      projectId: task?.projectId ?? null,
    };
    mcpServers = generateGeminiAcpMcpServers(config.MCP_SERVER_PATH, identity);
    console.log(`[session-runner] Gemini MCP injected for session ${sessionId}`);
  }

  // Phase E: Prepend context preamble on new sessions (not resumes) when MCP
  // is active. This tells the agent what task it is working on and instructs it
  // to use the Agendo MCP tools for reporting progress.
  // Only inject for claude; other binaries don't have the MCP tools available.
  if (agent.mcpEnabled && !resumeRef && prompt && binaryName === 'claude') {
    const projectName = project?.name ?? 'unknown';
    const preamble =
      `[Agendo Context: task_id=${session.taskId ?? 'none'}, project=${projectName}]\n` +
      `Agendo MCP tools are available. See your task with get_my_task. Report all progress.\n` +
      `---\n`;
    prompt = preamble + prompt;
  }

  // Phase F: On cold resume, prepend a summary of recent task progress notes so
  // the agent has context about what was accomplished before the session ended.
  if (resumeRef && session.taskId && task) {
    const recentEvents = await listTaskEvents(session.taskId, 10);
    const progressNotes = recentEvents.filter((e) => e.eventType === 'agent_note').slice(0, 5);

    if (progressNotes.length > 0 || task) {
      const notesText =
        progressNotes.length > 0
          ? progressNotes
              .map((e) => `  - "${(e.payload as { note?: string }).note ?? ''}"`)
              .join('\n')
          : '  (none yet)';

      const resumeContext =
        `[Previous Work Summary]\n` +
        `Task: ${task.title}\n` +
        `Recent progress notes:\n` +
        `${notesText}\n` +
        `---\n` +
        `Continue from where you left off.\n\n`;
      prompt = resumeContext + prompt;
    }
  }

  // Mark session as active (before starting so concurrency checks work)
  await db
    .update(sessions)
    .set({ status: 'active', startedAt: new Date(), workerId })
    .where(eq(sessions.id, sessionId));

  const adapter = selectAdapter(agent, capability);
  const sessionProc = new SessionProcess(session, adapter, workerId);
  await sessionProc.start(
    prompt,
    resumeRef ?? session.sessionRef ?? undefined,
    resolvedCwd,
    envOverrides,
    mcpConfigPath,
    mcpServers,
  );

  // Wait until the session releases its pg-boss slot (first awaiting_input or
  // process exit). This frees the slot for the next queued session while the
  // agent process stays alive in liveSessionProcs for subsequent messages.
  await sessionProc.waitForSlotRelease();

  // Register the live session so the shutdown handler can terminate it gracefully.
  liveSessionProcs.set(sessionId, sessionProc);
  console.log(
    `[session-runner] slot released for session ${sessionId} — ${liveSessionProcs.size} live session(s)`,
  );

  // Wire exit cleanup: remove from live map when the process actually exits.
  void sessionProc.waitForExit().then(() => {
    liveSessionProcs.delete(sessionId);
    console.log(
      `[session-runner] session ${sessionId} removed from live map — ${liveSessionProcs.size} live session(s) remaining`,
    );
  });
}
