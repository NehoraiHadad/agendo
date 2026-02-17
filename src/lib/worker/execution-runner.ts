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

// --- Constants ---

const SIGKILL_DELAY_MS = 5_000;
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
export async function runExecution({ executionId, workerId }: RunExecutionInput): Promise<void> {
  // --- 1. Load records ---
  const execution = await loadExecution(executionId);
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
    await db
      .update(executions)
      .set({ prompt: resolvedPrompt })
      .where(eq(executions.id, executionId));
  } else {
    resolvedArgs = buildCommandArgs(capability.commandTokens ?? [], execution.args);
  }

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
  heartbeat.stop();

  logWriter.writeSystem(`Process exited with code ${exitCode}`);
  const logStats = await logWriter.close();

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
