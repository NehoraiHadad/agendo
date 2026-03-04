import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, projects } from '@/lib/db/schema';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-runner');
import { getSession } from '@/lib/services/session-service';
import { getAgentById } from '@/lib/services/agent-service';
import { getCapabilityById } from '@/lib/services/capability-service';
import { validateWorkingDir, validateBinary } from '@/lib/worker/safety';
import { SessionProcess } from '@/lib/worker/session-process';
import { selectAdapter } from '@/lib/worker/adapters/adapter-factory';
import { generateSessionMcpConfig, generateGeminiAcpMcpServers } from '@/lib/mcp/config-templates';
import { listTaskEvents } from '@/lib/services/task-event-service';
import type { AcpMcpServer, ImageContent } from '@/lib/worker/adapters/types';

/**
 * Live session processes that have released their pg-boss slot (reached
 * awaiting_input) but whose underlying agent process is still running.
 * Keyed by sessionId. Used by shutdown to gracefully terminate them.
 */
export const liveSessionProcs = new Map<string, SessionProcess>();

/**
 * ALL active session processes, registered immediately when runSession starts
 * (before the first awaiting_input). This superset of liveSessionProcs lets
 * the shutdown handler call markTerminating() synchronously on every proc —
 * critical for SIGINT/SIGTERM sent to the whole process group, where Claude
 * exits concurrently with our shutdown handler and we must set terminateKilled
 * before the onExit I/O callback fires.
 */
export const allSessionProcs = new Map<string, SessionProcess>();

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
  resumeSessionAt?: string,
  resumePrompt?: string,
): Promise<void> {
  const session = await getSession(sessionId);
  const agent = await getAgentById(session.agentId);
  const capability = await getCapabilityById(session.capabilityId);

  validateBinary(agent.binaryPath);

  // Load task for workingDir, env overrides, and prompt interpolation (may be null for conversations)
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
        .then((r) => r[0] ?? null)
    : null;

  // Load project — prefer session.projectId (direct), fallback to task.projectId
  const resolvedProjectId = session.projectId ?? task?.projectId ?? null;
  const project = resolvedProjectId
    ? await db
        .select()
        .from(projects)
        .where(eq(projects.id, resolvedProjectId))
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
  if (resolvedProjectId) {
    envOverrides['AGENDO_PROJECT_ID'] = resolvedProjectId;
  }

  // Resolve the prompt:
  // - On cold resume (resumeRef set): use resumePrompt from job data (the user's new message).
  //   session.initialPrompt is NOT used here so it stays as the original first prompt for the UI.
  // - On first spawn (no resumeRef): use session.initialPrompt (the original user prompt).
  let prompt = (resumeRef ? resumePrompt : undefined) ?? session.initialPrompt ?? '';
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
      projectId: resolvedProjectId,
    };
    const mcpConfig = generateSessionMcpConfig(config.MCP_SERVER_PATH, identity);
    mcpConfigPath = `/tmp/agendo-mcp-${sessionId}.json`;
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    log.info({ sessionId }, 'Claude MCP config written');
  }

  // Phase A2: For Gemini and Codex, inject MCP servers with session identity.
  // Gemini: passed via ACP session/new mcpServers field.
  // Codex: passed via SpawnOpts.mcpServers → config/batchWrite in the adapter.
  let mcpServers: AcpMcpServer[] | undefined;
  if (
    agent.mcpEnabled &&
    config.MCP_SERVER_PATH &&
    (binaryName === 'gemini' || binaryName === 'codex')
  ) {
    const identity = {
      sessionId,
      taskId: session.taskId,
      agentId: session.agentId,
      projectId: resolvedProjectId,
    };
    mcpServers = generateGeminiAcpMcpServers(config.MCP_SERVER_PATH, identity);
    log.info({ sessionId, binaryName }, 'MCP injected for session');
  }

  // Phase E: Prepend context preamble on new sessions (not resumes) when MCP
  // is active. This tells the agent what task it is working on and instructs it
  // to use the Agendo MCP tools for reporting progress.
  // Codex gets MCP tools via its global config.toml (agendo MCP server) with
  // session identity passed as env vars — so it also qualifies for the preamble.
  const hasMcp =
    agent.mcpEnabled &&
    (binaryName === 'claude' || binaryName === 'gemini' || binaryName === 'codex');
  let codexDeveloperInstructions: string | undefined;
  if (hasMcp && !resumeRef && prompt) {
    const projectName = project?.name ?? 'unknown';
    let preamble: string;
    if (session.kind === 'conversation') {
      // Planning conversation preamble — no task context.
      // Kept intentionally brief; the full agent-execution guidance lives in the
      // initialPrompt constructed by plan-service.ts startPlanConversation().
      preamble =
        `[Agendo Context: project=${projectName}, mode=planning]\n` +
        `Agendo MCP tools are available. You are in a planning conversation.\n` +
        `- create_task / create_subtask — turn plan steps into actionable tasks\n` +
        `- list_tasks / get_task — inspect existing tasks and their status\n` +
        `- list_projects — list all projects (needed to resolve projectId for create_task)\n` +
        `- start_agent_session — spawn an agent on a task when ready to execute\n` +
        `---\n`;
    } else {
      // Execution preamble — task context
      preamble =
        `[Agendo Context: task_id=${session.taskId ?? 'none'}, project=${projectName}]\n` +
        `Agendo MCP tools are available. See your task with get_my_task. Report all progress with add_progress_note.\n` +
        `If you encounter something you cannot do because an MCP tool is missing, create a new task using create_task with:\n` +
        `  - A clear title: "Add MCP tool: <tool_name>"\n` +
        `  - Description: what the tool should do, what inputs it needs, what it should return, and why you need it\n` +
        `  - This ensures missing capabilities get built so future agents can do the job fully\n` +
        `---\n`;
    }
    if (binaryName === 'codex') {
      // Codex: inject preamble as developerInstructions (system-level, not a user turn)
      // instead of prepending to the prompt. This keeps the user's initial message clean.
      codexDeveloperInstructions = preamble;
    } else {
      prompt = preamble + prompt;
    }
  }

  // Phase F: On cold resume, prepend a summary of recent task progress notes so
  // the agent has context about what was accomplished before the session ended.
  // Save the user's display text BEFORE prepending the context so the chat view
  // shows only what the user actually typed (not the system preamble).
  const userResumeText = resumeRef ? prompt : undefined;
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

      // Check if the most recent note is an interruption marker so we can
      // give the agent a more precise instruction than "continue from where you left off".
      const mostRecentNote = progressNotes[0];
      const mostRecentNoteText =
        (mostRecentNote?.payload as { note?: string } | undefined)?.note ?? '';
      const wasInterrupted = mostRecentNoteText.includes('Session interrupted mid-turn');
      const continuationInstruction = wasInterrupted
        ? 'Your previous session was interrupted mid-turn. Review the most recent note above and verify whether your last action completed before proceeding.'
        : 'Continue from where you left off.';

      const resumeContext =
        `[Previous Work Summary]\n` +
        `Task: ${task.title}\n` +
        `Recent progress notes:\n` +
        `${notesText}\n` +
        `---\n` +
        `${continuationInstruction}\n\n`;
      prompt = resumeContext + prompt;
    }
  }

  // Check for a pending resume image saved by the message API (cold resume with attachment).
  let initialImage: ImageContent | undefined;
  if (resumeRef ?? session.sessionRef) {
    const pendingMetaPath = join(config.LOG_DIR, 'attachments', sessionId, 'resume-pending.json');
    if (existsSync(pendingMetaPath)) {
      try {
        const meta = JSON.parse(readFileSync(pendingMetaPath, 'utf-8')) as {
          path: string;
          mimeType: string;
        };
        const data = readFileSync(meta.path).toString('base64');
        initialImage = { mimeType: meta.mimeType, data };
        // Clean up after reading (best-effort)
        try {
          unlinkSync(meta.path);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(pendingMetaPath);
        } catch {
          /* ignore */
        }
        log.info({ sessionId }, 'Loaded pending resume image');
      } catch (err) {
        log.warn({ err, sessionId }, 'Failed to read pending resume image');
      }
    }
  }

  const adapter = selectAdapter(agent);
  const sessionProc = new SessionProcess(session, adapter, workerId);

  // Register immediately so the shutdown handler can markTerminating() even
  // before the first awaiting_input (i.e. while still in active state).
  allSessionProcs.set(sessionId, sessionProc);

  await sessionProc.start(
    prompt,
    resumeRef ?? session.sessionRef ?? undefined,
    resolvedCwd,
    envOverrides,
    mcpConfigPath,
    mcpServers,
    initialImage,
    userResumeText,
    resumeSessionAt,
    codexDeveloperInstructions,
  );

  // Wait until the session releases its pg-boss slot (first awaiting_input or
  // process exit). This frees the slot for the next queued session while the
  // agent process stays alive in liveSessionProcs for subsequent messages.
  await sessionProc.waitForSlotRelease();

  // Register the live session so the shutdown handler can terminate it gracefully.
  liveSessionProcs.set(sessionId, sessionProc);
  log.info({ sessionId, liveSessions: liveSessionProcs.size }, 'slot released for session');

  // Wire exit cleanup: remove from both maps when the process actually exits,
  // and clean up the ephemeral MCP config file written for this session.
  void sessionProc.waitForExit().then(() => {
    allSessionProcs.delete(sessionId);
    liveSessionProcs.delete(sessionId);
    log.info({ sessionId, liveSessions: liveSessionProcs.size }, 'session removed from live map');
    if (mcpConfigPath) {
      try {
        unlinkSync(mcpConfigPath);
      } catch {
        // Best-effort: file may already be gone.
      }
    }
  });
}
