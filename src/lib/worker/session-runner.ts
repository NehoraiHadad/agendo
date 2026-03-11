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
import { validateWorkingDir, validateBinary } from '@/lib/worker/safety';
import { SessionProcess } from '@/lib/worker/session-process';
import { selectAdapter } from '@/lib/worker/adapters/adapter-factory';
import { getBinaryName } from '@/lib/worker/agent-utils';
import { generateSessionMcpConfig, generateGeminiAcpMcpServers } from '@/lib/mcp/config-templates';
import { resolveSessionMcpServers, resolveByMcpServerIds } from '@/lib/services/mcp-server-service';
import { getDefaultModel, type Provider } from '@/lib/services/model-service';
import { listTaskEvents } from '@/lib/services/task-event-service';
import {
  generateExecutionPreamble,
  generatePlanningPreamble,
  generateSupportPreamble,
  generateResumeContext,
} from '@/lib/worker/session-preambles';
import type { AcpMcpServer, ImageContent } from '@/lib/worker/adapters/types';

/** Map CLI binary name to model-service provider. */
function binaryNameToProvider(name: string): Provider | null {
  if (name === 'claude') return 'anthropic';
  if (name === 'codex') return 'openai';
  if (name === 'gemini') return 'google';
  return null;
}

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

export async function runSession(
  sessionId: string,
  workerId: string,
  resumeRef?: string,
  resumeSessionAt?: string,
  resumePrompt?: string,
): Promise<void> {
  const session = await getSession(sessionId);
  const agent = await getAgentById(session.agentId);

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
  if (!prompt && task) {
    prompt = [task.title, task.description ?? ''].filter(Boolean).join('\n\n');
  }

  // Determine the binary basename so we can gate claude-only features below.
  const binaryName = getBinaryName(agent);

  // Load additional user-configured MCP servers for this session.
  // Priority: session-level mcpServerIds (explicit selection) > project-level defaults.
  const additionalMcps = session.mcpServerIds?.length
    ? await resolveByMcpServerIds(session.mcpServerIds)
    : resolvedProjectId
      ? await resolveSessionMcpServers(resolvedProjectId)
      : [];
  if (additionalMcps.length > 0) {
    log.info(
      { sessionId, count: additionalMcps.length, names: additionalMcps.map((s) => s.name) },
      'Additional MCP servers resolved',
    );
  }

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
    const mcpConfig = generateSessionMcpConfig(config.MCP_SERVER_PATH, identity, additionalMcps);
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
    mcpServers = generateGeminiAcpMcpServers(config.MCP_SERVER_PATH, identity, additionalMcps);
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

  // Support sessions: always inject preamble (no MCP dependency)
  if (session.kind === 'support' && !resumeRef && prompt) {
    const supportPreamble = generateSupportPreamble();
    if (binaryName === 'codex') {
      codexDeveloperInstructions = supportPreamble;
    } else {
      prompt = supportPreamble + prompt;
    }
  } else if (hasMcp && !resumeRef && prompt) {
    const projectName = project?.name ?? 'unknown';
    const preamble = session.taskId
      ? generateExecutionPreamble(projectName, session.taskId)
      : generatePlanningPreamble(projectName);
    if (binaryName === 'codex') {
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
      const mostRecentNote = progressNotes[0];
      const mostRecentNoteText =
        (mostRecentNote?.payload as { note?: string } | undefined)?.note ?? '';
      const wasInterrupted = mostRecentNoteText.includes('Session interrupted mid-turn');

      const resumeCtx = generateResumeContext(task.title, progressNotes, wasInterrupted);
      prompt = resumeCtx + prompt;
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

  // Resolve default model from the CLI's local data when not set on the session.
  // This avoids hardcoding model names — the model-service reads from each CLI's
  // installed files (e.g. Gemini's models.js, Codex's models_cache.json).
  if (!session.model) {
    const provider = binaryNameToProvider(binaryName);
    if (provider) {
      try {
        const defaultModel = await getDefaultModel(provider);
        if (defaultModel) {
          session.model = defaultModel;
          log.info(
            { sessionId, binaryName, model: defaultModel },
            'Resolved default model from CLI',
          );
        }
      } catch (err) {
        log.warn(
          { err, sessionId },
          'Failed to resolve default model, CLI will use its own default',
        );
      }
    }
  }

  const adapter = selectAdapter(agent);
  const sessionProc = new SessionProcess(session, adapter, workerId);

  // Register immediately so the shutdown handler can markTerminating() even
  // before the first awaiting_input (i.e. while still in active state).
  allSessionProcs.set(sessionId, sessionProc);

  await sessionProc.start({
    prompt,
    resumeRef: resumeRef ?? session.sessionRef ?? undefined,
    spawnCwd: resolvedCwd,
    envOverrides,
    mcpConfigPath,
    mcpServers,
    initialImage,
    displayText: userResumeText,
    resumeSessionAt,
    developerInstructions: codexDeveloperInstructions,
  });

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
