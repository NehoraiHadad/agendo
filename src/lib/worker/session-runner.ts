import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-runner');
import { getSession } from '@/lib/services/session-service';
import { validateBinary } from '@/lib/worker/safety';
import { SessionProcess } from '@/lib/worker/session-process';
import { selectAdapter } from '@/lib/worker/adapters/adapter-factory';
import { getBinaryName } from '@/lib/worker/agent-utils';
import {
  generateSdkSessionMcpServers,
  generateGeminiAcpMcpServers,
} from '@/lib/mcp/config-templates';
import { resolveSessionMcpServers, resolveByMcpServerIds } from '@/lib/services/mcp-server-service';
import { getDefaultModel } from '@/lib/services/model-service';
import { readPendingResumeAttachments } from '@/lib/services/session-attachment-service';
import { resolveSessionRuntimeContext } from '@/lib/services/session-runtime-context';
import { listTaskEvents } from '@/lib/services/task-event-service';
import {
  generateExecutionPreamble,
  generatePlanningPreamble,
  generateSupportPreamble,
  generateResumeContext,
} from '@/lib/worker/session-preambles';
import type { AcpMcpServer, SpawnOpts } from '@/lib/worker/adapters/types';
import { binaryNameToProvider } from '@/lib/worker/fallback/provider-utils';

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

/**
 * Look up a live SessionProcess by sessionId.
 *
 * Returns the SessionProcess if this worker has an active or awaiting-input
 * process for the given session, or undefined if the session is not running
 * in this worker (e.g. different worker, or the process has already exited).
 *
 * Checks allSessionProcs (covers both pre-slot-release active sessions and
 * post-slot-release awaiting-input sessions) so callers can deliver messages
 * at any point in the session lifecycle without going through PG NOTIFY.
 */
export function getSessionProc(sessionId: string): SessionProcess | undefined {
  return allSessionProcs.get(sessionId);
}

export async function runSession(
  sessionId: string,
  workerId: string,
  resumeRef?: string,
  resumeSessionAt?: string,
  resumePrompt?: string,
  skipResumeContext?: boolean,
  resumeClientId?: string,
): Promise<void> {
  const session = await getSession(sessionId);
  const runtime = await resolveSessionRuntimeContext(sessionId);
  const { agent, task, project, resolvedProjectId, cwd: resolvedCwd, envOverrides } = runtime;

  validateBinary(agent.binaryPath);

  // Resolve the prompt from job data. resumePrompt covers both first-spawn and cold-resume —
  // all enqueue callsites now pass it explicitly. session.initialPrompt is kept as a fallback
  // for backward-compat (old jobs in flight) and for clearContextRestart child sessions whose
  // prompt is written to DB by restartFreshFromSession(). The UI reads session.initialPrompt
  // directly for the InitialPromptBanner and search; the worker no longer depends on it.
  let prompt = resumePrompt ?? session.initialPrompt ?? '';
  if (!prompt && task) {
    // Use only the title as the directive — full details (description, status,
    // subtasks, progress notes) are retrieved via get_my_task at session start.
    prompt = task.title;
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

  // Phase A: Generate SDK-format MCP servers for Claude (no temp file needed).
  // The SDK accepts MCP server configs directly in Options.mcpServers.
  let sdkMcpServers: SpawnOpts['sdkMcpServers'] | undefined;
  if (agent.mcpEnabled && config.MCP_SERVER_PATH && binaryName === 'claude') {
    const identity = {
      sessionId,
      taskId: session.taskId,
      agentId: session.agentId,
      projectId: resolvedProjectId,
    };
    sdkMcpServers = generateSdkSessionMcpServers(config.MCP_SERVER_PATH, identity, additionalMcps);
    log.info({ sessionId }, 'Claude SDK MCP servers generated');
  }

  // Phase A2: For Gemini, Codex, Copilot, and OpenCode, inject MCP servers with session identity.
  // Gemini: passed via ACP session/new mcpServers field.
  // Codex: passed via SpawnOpts.mcpServers → config/batchWrite in the adapter.
  // Copilot: passed via SpawnOpts.mcpServers → --additional-mcp-config CLI flag in buildArgs().
  // OpenCode: passed via SpawnOpts.mcpServers → OPENCODE_CONFIG_CONTENT env var in prepareOpts().
  let mcpServers: AcpMcpServer[] | undefined;
  if (
    agent.mcpEnabled &&
    config.MCP_SERVER_PATH &&
    (binaryName === 'gemini' ||
      binaryName === 'codex' ||
      binaryName === 'copilot' ||
      binaryName === 'opencode')
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

  // Phase E: Inject dynamic context preamble into agent sessions.
  //
  // Skills are now loaded via native SKILL.md files (installed at worker startup),
  // so only per-session dynamic context (task ID, project name) is injected here.
  const hasMcp =
    agent.mcpEnabled &&
    (binaryName === 'claude' ||
      binaryName === 'gemini' ||
      binaryName === 'codex' ||
      binaryName === 'copilot' ||
      binaryName === 'opencode');

  let codexDeveloperInstructions: string | undefined;

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

  // Phase F: On cold resume, prepend context so the agent can verify what was
  // already done before taking action. Prevents repeating completed steps.
  // Save the user's display text BEFORE prepending the context so the chat view
  // shows only what the user actually typed (not the system preamble).
  //
  // skipResumeContext=true is set for mid-turn auto-resumes (worker/infra restart).
  // In those cases the agent already has its full conversation history via resumeRef,
  // so prepending a context dump is redundant — the short resumePrompt is enough.
  const userResumeText = resumeRef ? prompt : undefined;
  if (resumeRef && !skipResumeContext) {
    if (session.taskId && task) {
      // Task sessions: prepend progress notes + verification instruction.
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
    } else {
      // Planning/conversation sessions (no taskId, no progress notes):
      // Inject a brief verification instruction so the agent checks what was
      // already done before acting — prevents repeating completed steps.
      const planningResumeCtx =
        `[Resume Context]\n` +
        `Your session was interrupted mid-turn. Review your conversation history to verify ` +
        `what was already completed before taking further action.\n` +
        `---\n`;
      prompt = planningResumeCtx + prompt;
    }
  }

  // Check for pending resume attachments saved by the message API (cold resume).
  let initialAttachments: import('@/lib/attachments').AttachmentRef[] | undefined;
  if (resumeRef ?? session.sessionRef) {
    const pendingMetaPath = join(config.LOG_DIR, 'attachments', sessionId, 'resume-pending.json');
    if (existsSync(pendingMetaPath)) {
      const pendingAttachments = readPendingResumeAttachments(sessionId);
      if (pendingAttachments.length > 0) {
        initialAttachments = pendingAttachments;
        log.info(
          { sessionId, count: pendingAttachments.length },
          'Loaded pending resume attachments',
        );
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

  // Guard: if this session already has a live process on this worker, skip.
  // This prevents a duplicate pg-boss job (e.g. from a cold-resume fallback
  // that fired while the process was still alive) from overwriting the live
  // sessionProc reference in the maps — which would orphan the real process.
  const existingProc = allSessionProcs.get(sessionId);
  if (existingProc) {
    log.info(
      { sessionId },
      'Session already has live process on this worker, skipping duplicate job',
    );
    return;
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
    sdkMcpServers,
    mcpServers,
    initialAttachments,
    displayText: userResumeText,
    displayClientId: resumeClientId,
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

  // Wire exit cleanup: remove from both maps when the process actually exits.
  // Only delete if the entry still points to THIS sessionProc — a later
  // runSession call may have legitimately replaced us (e.g. after cold resume).
  void sessionProc.waitForExit().then(() => {
    if (allSessionProcs.get(sessionId) === sessionProc) {
      allSessionProcs.delete(sessionId);
    }
    if (liveSessionProcs.get(sessionId) === sessionProc) {
      liveSessionProcs.delete(sessionId);
    }
    log.info({ sessionId, liveSessions: liveSessionProcs.size }, 'session removed from live map');
  });
}
