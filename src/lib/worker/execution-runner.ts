import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { executions, tasks } from '@/lib/db/schema';
import { getAgentById } from '@/lib/services/agent-service';
import { getCapabilityById } from '@/lib/services/capability-service';
import {
  validateWorkingDir,
  buildChildEnv,
  buildCommandArgs,
  validateArgs,
  validateBinary,
} from '@/lib/worker/safety';
import { FileLogWriter, resolveLogPath } from '@/lib/worker/log-writer';
import { ExecutionHeartbeat } from '@/lib/worker/heartbeat';
import { selectAdapter } from '@/lib/worker/adapters/adapter-factory';
import type { ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';
import type { Execution, ExecutionStatus } from '@/lib/types';
import { config } from '@/lib/config';

// --- Constants ---

const SIGKILL_DELAY_MS = 5_000;
const RESULT_EXIT_GRACE_MS = 10_000; // max wait after result event before force-killing (GitHub #25629)
const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

// --- Types ---

export interface RunExecutionInput {
  executionId: string;
  workerId: string;
}

// --- Main Function ---

/**
 * Runs a single execution end-to-end:
 * 1. Load execution + agent + capability from DB
 * 2. Safety checks (working dir, binary, args, env)
 * 3. Select adapter (claude/codex/gemini/template) based on mode + agent
 * 4. Spawn via adapter -> track output -> enforce limits
 * 5. Finalize with WHERE status='running' guard
 */
const TERMINAL_STATUSES = new Set<string>(['succeeded', 'failed', 'cancelled', 'timed_out']);

export async function runExecution({ executionId, workerId }: RunExecutionInput): Promise<void> {
  // --- 1. Load records ---
  const execution = await loadExecution(executionId);

  // Guard: pg-boss may retry a job if the worker was killed before acking it.
  // If the execution already reached a terminal state (e.g. a previous worker run
  // completed it before dying), skip re-execution to avoid running Claude twice.
  if (TERMINAL_STATUSES.has(execution.status)) {
    console.log(
      `[worker] Execution ${executionId} already in terminal state '${execution.status}' — skipping re-run.`,
    );
    return;
  }

  // Session-process path (new real-time channel)
  if (config.USE_SESSION_PROCESS && execution.sessionId) {
    const { SessionProcess } = await import('@/lib/worker/session-process');
    const { getSession } = await import('@/lib/services/session-service');
    const session = await getSession(execution.sessionId);
    const agent = await getAgentById(execution.agentId);
    const capability = await getCapabilityById(execution.capabilityId);
    const resolvedCwd = validateWorkingDir(agent.workingDir ?? '/tmp');
    validateBinary(agent.binaryPath);
    const childEnv = buildChildEnv({ agentAllowlist: agent.envAllowlist ?? [] });

    let resolvedPrompt = '';
    if (execution.promptOverride) {
      resolvedPrompt = execution.promptOverride;
    } else if (capability.promptTemplate) {
      const [task] = await db
        .select({ title: tasks.title, description: tasks.description })
        .from(tasks)
        .where(eq(tasks.id, execution.taskId))
        .limit(1);
      resolvedPrompt = interpolatePrompt(capability.promptTemplate, {
        task_title: task?.title ?? '',
        task_description: task?.description ?? '',
        ...execution.args,
      });
    }

    const adapter = selectAdapter(agent, capability);
    void childEnv; // referenced by adapter internals via spawnOpts

    // Mark execution as running so the UI shows activity and concurrency checks work.
    await db
      .update(executions)
      .set({ status: 'running', startedAt: new Date(), workerId })
      .where(eq(executions.id, executionId));

    const sessionProc = new SessionProcess(session, adapter, executionId, workerId);
    await sessionProc.start(resolvedPrompt, execution.sessionRef ?? undefined, resolvedCwd);
    const exitCode = await sessionProc.waitForExit();

    // Finalize execution record. No WHERE status='running' guard here — the session
    // path owns this execution exclusively, so a direct update is safe.
    // For sessions: idle-timeout kill (exit 137) is normal suspension, not failure.
    // Re-fetch session status to determine if this was a normal end.
    const finalSession = await getSession(execution.sessionId!);
    const sessionEndedNormally =
      finalSession.status === 'idle' ||
      finalSession.status === 'awaiting_input';
    const finalStatus = exitCode === 0 || sessionEndedNormally ? 'succeeded' : 'failed';
    await db
      .update(executions)
      .set({ status: finalStatus, exitCode, endedAt: new Date() })
      .where(eq(executions.id, executionId));
    return;
  }

  const agent = await getAgentById(execution.agentId);
  const capability = await getCapabilityById(execution.capabilityId);

  // --- 2. Safety checks ---
  const resolvedCwd = validateWorkingDir(agent.workingDir ?? '/tmp');
  validateBinary(agent.binaryPath);
  validateArgs(capability.argsSchema, execution.args);

  const childEnv = buildChildEnv({
    agentAllowlist: agent.envAllowlist ?? [],
  });

  // --- 3. Resolve prompt or command args ---
  let resolvedPrompt: string | undefined;
  let resolvedArgs: string[] | undefined;

  if (execution.mode === 'prompt') {
    // If promptOverride is set, use it directly (session continuation path)
    if (execution.promptOverride) {
      resolvedPrompt = execution.promptOverride;
    } else {
      // Load task to get title/description for template interpolation
      const [task] = await db
        .select({ title: tasks.title, description: tasks.description })
        .from(tasks)
        .where(eq(tasks.id, execution.taskId))
        .limit(1);

      const interpolationContext: Record<string, unknown> = {
        task_title: task?.title ?? '',
        task_description: task?.description ?? '',
        ...execution.args,
      };
      resolvedPrompt = interpolatePrompt(capability.promptTemplate ?? '', interpolationContext);
    }
    await db
      .update(executions)
      .set({ prompt: resolvedPrompt })
      .where(eq(executions.id, executionId));
  } else {
    resolvedArgs = buildCommandArgs(capability.commandTokens ?? [], execution.args);
  }

  // --- 3b. Build extra CLI flags argv ---
  const extraArgs = buildCliFlagsArgv(
    (execution.cliFlags as Record<string, string | boolean>) ?? {},
  );

  // --- 4. Set up log writer + heartbeat ---
  const logPath = resolveLogPath(executionId);
  const logWriter = new FileLogWriter(executionId, logPath);
  logWriter.open();

  const heartbeat = new ExecutionHeartbeat(executionId);
  heartbeat.start();

  // Update execution with log path and running status
  await db
    .update(executions)
    .set({
      status: 'running',
      logFilePath: logPath,
      startedAt: new Date(),
      workerId,
    })
    .where(eq(executions.id, executionId));

  logWriter.writeSystem(`Execution ${executionId} started`);
  logWriter.writeSystem(`Agent: ${agent.name} | Mode: ${execution.mode} | CWD: ${resolvedCwd}`);

  // --- 5. Select adapter and spawn ---
  const adapter = selectAdapter(agent, capability);

  const spawnOpts: SpawnOpts = {
    cwd: resolvedCwd,
    env: childEnv,
    executionId,
    timeoutSec: capability.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    maxOutputBytes: capability.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    extraArgs,
  };

  let managedProcess: ManagedProcess;

  if (execution.mode === 'prompt' && execution.parentExecutionId && execution.sessionRef) {
    logWriter.writeSystem(`Resuming session: ${execution.sessionRef}`);
    managedProcess = adapter.resume(execution.sessionRef, resolvedPrompt ?? '', spawnOpts);
  } else if (execution.mode === 'prompt') {
    managedProcess = adapter.spawn(resolvedPrompt ?? '', spawnOpts);
  } else {
    managedProcess = adapter.spawn((resolvedArgs ?? []).join(' '), spawnOpts);
  }

  // Store PID and tmux session name
  await db
    .update(executions)
    .set({
      pid: managedProcess.pid,
      tmuxSessionName: managedProcess.tmuxSession,
    })
    .where(eq(executions.id, executionId));

  // --- 6. Track output ---
  let sessionId: string | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let resultKillTimer: ReturnType<typeof setTimeout> | null = null;

  managedProcess.onData((chunk) => {
    logWriter.write(chunk, 'stdout');

    if (!sessionId) {
      sessionId = adapter.extractSessionId(chunk);
      if (sessionId) {
        void db
          .update(executions)
          .set({ sessionRef: sessionId })
          .where(eq(executions.id, executionId));
      }
    }

    if (logWriter.stats.byteSize > (capability.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) {
      logWriter.writeSystem('Output limit exceeded. Terminating.');
      managedProcess.kill('SIGTERM');
    }

    // Workaround for GitHub #25629: Claude sometimes never closes stdout after emitting
    // the final result event. Schedule a SIGKILL after a grace period so the execution
    // doesn't stay stuck as 'running' for 45 minutes waiting for an exit that never comes.
    if (!resultKillTimer) {
      for (const line of chunk.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const ev = JSON.parse(line) as { type?: string };
          if (ev.type === 'result') {
            resultKillTimer = setTimeout(() => {
              logWriter.writeSystem('Claude result event seen but process did not exit. Sending SIGKILL.');
              managedProcess.kill('SIGKILL');
            }, RESULT_EXIT_GRACE_MS);
            break;
          }
        } catch {
          // not JSON
        }
      }
    }
  });

  // --- 7. Set timeout ---
  const timeoutMs = (capability.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  timeoutTimer = setTimeout(() => {
    logWriter.writeSystem(
      `Timeout after ${capability.timeoutSec ?? DEFAULT_TIMEOUT_SEC}s. Sending SIGTERM.`,
    );
    managedProcess.kill('SIGTERM');
    setTimeout(() => {
      logWriter.writeSystem('Grace period expired. Sending SIGKILL.');
      managedProcess.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
  }, timeoutMs);

  // --- 8. Wait for exit and finalize ---
  const exitCode = await new Promise<number | null>((resolve) => {
    managedProcess.onExit((code) => resolve(code));
  });

  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (resultKillTimer) clearTimeout(resultKillTimer);
  heartbeat.stop();

  logWriter.writeSystem(`Process exited with code ${exitCode}`);
  const logStats = await logWriter.close();

  // Scan log for cost/turns/duration from Claude result event
  let totalCostUsd: string | null = null;
  let totalTurns: number | null = null;
  let totalDurationMs: number | null = null;

  if (logPath) {
    try {
      const { readFileSync: readLogFile, existsSync: existsSyncLocal } = await import('node:fs');
      if (existsSyncLocal(logPath)) {
        const logContent = readLogFile(logPath, 'utf-8');
        for (const rawLine of logContent.split('\n')) {
          const line = rawLine.replace(/^\[(stdout|stderr|system)\] /, '');
          if (!line.startsWith('{')) continue;
          try {
            const ev = JSON.parse(line) as {
              type?: string;
              subtype?: string;
              total_cost_usd?: number;
              num_turns?: number;
              duration_ms?: number;
            };
            if (ev.type === 'result' && ev.subtype === 'success') {
              if (ev.total_cost_usd != null) totalCostUsd = String(ev.total_cost_usd);
              if (ev.num_turns != null) totalTurns = ev.num_turns;
              if (ev.duration_ms != null) totalDurationMs = ev.duration_ms;
            }
          } catch {
            /* not JSON */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // --- 9. Finalize with race guard ---
  const finalStatus = determineFinalStatus(exitCode, logStats.byteSize, capability.maxOutputBytes);

  const result = await db
    .update(executions)
    .set({
      status: finalStatus,
      exitCode,
      endedAt: new Date(),
      logByteSize: logStats.byteSize,
      logLineCount: logStats.lineCount,
      // sessionRef may not have been persisted yet if the intermediate void update
      // was lost to a SIGINT race — include it here as a guaranteed fallback.
      ...(sessionId !== null && { sessionRef: sessionId }),
      ...(totalCostUsd !== null && { totalCostUsd }),
      ...(totalTurns !== null && { totalTurns }),
      ...(totalDurationMs !== null && { totalDurationMs }),
    })
    .where(and(eq(executions.id, executionId), eq(executions.status, 'running')));

  // If 0 rows updated, status was changed (likely to 'cancelling')
  if (result.rowCount === 0) {
    const current = await loadExecution(executionId);
    if (current.status === 'cancelling') {
      await db
        .update(executions)
        .set({
          status: 'cancelled',
          endedAt: new Date(),
          logByteSize: logStats.byteSize,
          logLineCount: logStats.lineCount,
        })
        .where(eq(executions.id, executionId));
    }
  }
}

// --- Helpers ---

function determineFinalStatus(
  exitCode: number | null,
  byteSize: number,
  maxOutputBytes?: number | null,
): ExecutionStatus {
  if (byteSize > (maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) return 'failed';
  if (exitCode === 0) return 'succeeded';
  if (exitCode === null) return 'timed_out';
  return 'failed';
}

function buildCliFlagsArgv(cliFlags: Record<string, string | boolean>): string[] {
  const argv: string[] = [];
  for (const [flag, value] of Object.entries(cliFlags)) {
    if (value === false) continue;
    if (value === true) {
      argv.push(flag);
    } else {
      argv.push(flag, value);
    }
  }
  return argv;
}

function interpolatePrompt(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_match, path: string) => {
    // Support dotted paths like {{input_context.prompt_additions}}
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

async function loadExecution(id: string): Promise<Execution> {
  const [row] = await db.select().from(executions).where(eq(executions.id, id)).limit(1);
  if (!row) throw new Error(`Execution not found: ${id}`);
  return row;
}
