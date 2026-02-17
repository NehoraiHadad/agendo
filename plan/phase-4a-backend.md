# Phase 4A: Execution Engine + Bidirectional Agent Communication (Backend)

> **Goal**: Worker executes real commands with a safety layer. Bidirectional adapters per agent (stream-json, JSON-RPC, tmux). All AI agents spawn inside tmux sessions. WebSocket terminal server via node-pty. Log streaming via SSE. Send Message API for follow-up messages. Session resume.
> **Depends on**: Phase 1 (schema, state machines, errors, api-handler), Phase 2 (agents, capabilities), Phase 3 (tasks, execution service skeleton)
> **New backend packages**: `socket.io node-pty`

---

## Prerequisites (Must Exist from Phase 1-3)

| File                                     | Purpose                                                                                                               | Phase |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----- |
| `src/lib/db/schema.ts`                   | `executions` table with `status`, `pid`, `sessionRef`, `tmuxSessionName`, `parentExecutionId`, log fields             | 1     |
| `src/lib/db/index.ts`                    | Drizzle singleton                                                                                                     | 1     |
| `src/lib/state-machines.ts`              | Execution status transitions: `queued -> running -> succeeded/failed/timed_out`, `running -> cancelling -> cancelled` | 1     |
| `src/lib/errors.ts`                      | `AppError` hierarchy                                                                                                  | 1     |
| `src/lib/api-handler.ts`                 | `withErrorBoundary` for API routes                                                                                    | 1     |
| `src/lib/types.ts`                       | `Execution`, `ExecutionStatus`, `Agent`, `AgentCapability` inferred types                                             | 1     |
| `src/lib/config.ts`                      | Zod-validated env config (`ALLOWED_WORKING_DIRS`, `LOG_DIR`, `WORKER_ID`, etc.)                                       | 1     |
| `src/lib/services/agent-service.ts`      | `getAgentById` (for env_allowlist lookup)                                                                             | 2     |
| `src/lib/services/capability-service.ts` | `getCapabilityById` (for command_tokens, prompt_template, args_schema)                                                | 2     |
| `src/worker/index.ts`                    | Worker entry point with pg-boss                                                                                       | 1     |

---

## Packages to Install

```bash
cd /home/ubuntu/projects/agent-monitor
pnpm add socket.io node-pty
```

`socket.io` for the WebSocket terminal server. `node-pty` for spawning PTY processes that attach to tmux sessions. Note: `node-pty` is a native addon and requires build tools (`python3`, `make`, `gcc`).

---

## Section A: Execution Core

### Step A1: Safety Module

**File**: `src/lib/worker/safety.ts`
**Purpose**: Validate working directories, build sanitized child environments, validate and substitute command arguments. All checks run before spawning any child process.
**Depends on**: `src/lib/config.ts` (for `ALLOWED_WORKING_DIRS` env var)

```typescript
// src/lib/worker/safety.ts

import { realpathSync, accessSync, constants, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { ValidationError } from '@/lib/errors';
import { config, allowedWorkingDirs } from '@/lib/config';

// --- Types ---

export interface SafeEnvOptions {
  /** Always-allowed base vars */
  base?: string[];
  /** Per-agent additional vars from agents.env_allowlist */
  agentAllowlist?: string[];
}

export interface ValidateArgsOptions {
  /** JSON Schema from capability.args_schema */
  schema: Record<string, unknown>;
  /** User-provided args */
  args: Record<string, unknown>;
}

// --- Constants ---

const BASE_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'] as const;

/** Reject arg values that could break token substitution */
const SAFE_ARG_PATTERN = /^[a-zA-Z0-9\s/_.,@#:=+\-]+$/;

// --- Functions ---

/**
 * Validates that workingDir is absolute, exists on disk, resolves through
 * symlinks, and falls within the configured allowlist.
 * Prevents symlink traversal by resolving BEFORE allowlist check.
 */
export function validateWorkingDir(workingDir: string): string {
  if (!isAbsolute(workingDir)) {
    throw new ValidationError(`Working directory must be absolute: ${workingDir}`);
  }

  if (!existsSync(workingDir)) {
    throw new ValidationError(`Working directory does not exist: ${workingDir}`);
  }

  // Resolve symlinks BEFORE allowlist check (prevents traversal)
  const resolved = realpathSync(workingDir);

  const isAllowed = allowedWorkingDirs.some(
    (allowed) => resolved === allowed || resolved.startsWith(allowed + '/'),
  );

  if (!isAllowed) {
    throw new ValidationError(
      `Working directory not in allowlist: ${resolved}. Allowed: ${allowedWorkingDirs.join(', ')}`,
    );
  }

  return resolved;
}

/**
 * Builds a minimal child process environment from scratch.
 * NEVER spreads process.env. Only includes explicitly allowlisted vars.
 */
export function buildChildEnv(opts: SafeEnvOptions = {}): Record<string, string> {
  const allowlist = [...BASE_ENV_ALLOWLIST, ...(opts.agentAllowlist ?? [])];

  const env: Record<string, string> = {};

  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Always set TERM for tmux/pty compatibility
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';

  return env;
}

/**
 * Substitutes {{placeholder}} tokens in command_tokens with validated arg values.
 * Rejects object/array values in token positions. Validates against pattern constraints.
 */
export function buildCommandArgs(commandTokens: string[], args: Record<string, unknown>): string[] {
  return commandTokens.map((token) => {
    const match = token.match(/^\{\{(\w+)\}\}$/);
    if (!match) return token; // literal token, no substitution

    const key = match[1];
    const value = args[key];

    if (value === undefined) {
      throw new ValidationError(`Missing required argument: ${key}`);
    }

    if (typeof value === 'object' || Array.isArray(value)) {
      throw new ValidationError(`Object/array values not allowed in command tokens: ${key}`);
    }

    const strValue = String(value);

    if (!SAFE_ARG_PATTERN.test(strValue)) {
      throw new ValidationError(`Argument "${key}" contains disallowed characters: ${strValue}`);
    }

    return strValue;
  });
}

/**
 * Validates user-provided args against the capability's JSON Schema.
 * Uses Zod for validation after converting from JSON Schema.
 * Flag injection prevention: schema should include pattern constraints.
 */
export function validateArgs(
  argsSchema: Record<string, unknown> | null,
  args: Record<string, unknown>,
): void {
  if (!argsSchema) return; // no schema = no validation needed

  // Reject any arg value that is an object (prevents nested injection)
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'object' && value !== null) {
      throw new ValidationError(`Argument "${key}" must be a scalar value, got ${typeof value}`);
    }
  }

  // Validate required fields from schema
  const required = (argsSchema.required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === '') {
      throw new ValidationError(`Missing required argument: ${key}`);
    }
  }

  // Validate pattern constraints from schema properties
  const properties = (argsSchema.properties as Record<string, { pattern?: string }>) ?? {};
  for (const [key, propSchema] of Object.entries(properties)) {
    if (args[key] !== undefined && propSchema.pattern) {
      const regex = new RegExp(propSchema.pattern);
      if (!regex.test(String(args[key]))) {
        throw new ValidationError(
          `Argument "${key}" does not match pattern: ${propSchema.pattern}`,
        );
      }
    }
  }
}

/**
 * Validates that a binary path exists and is executable.
 */
export function validateBinary(binaryPath: string): void {
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    throw new ValidationError(`Binary not found or not executable: ${binaryPath}`);
  }
}
```

**Key design decisions**:

- `realpathSync` runs BEFORE allowlist check to prevent symlink traversal attacks
- `buildChildEnv` never spreads `process.env` -- constructs from scratch with allowlist only
- `buildCommandArgs` rejects object/array values and checks against `SAFE_ARG_PATTERN`
- `validateBinary` uses `accessSync` with `X_OK` flag to check executability

---

### Step A2: Log Writer

**File**: `src/lib/worker/log-writer.ts`
**Purpose**: Write stdout/stderr output to log files. Tracks byte count and line count. Batches DB updates every 5 seconds to avoid per-line writes.
**Depends on**: `src/lib/db/index.ts`, `src/lib/db/schema.ts` (executions table)

```typescript
// src/lib/worker/log-writer.ts

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { config } from '@/lib/config';

// --- Constants ---

const DB_FLUSH_INTERVAL_MS = 5_000;

// --- Types ---

export interface LogWriterStats {
  byteSize: number;
  lineCount: number;
}

// --- FileLogWriter ---

export class FileLogWriter {
  private stream: WriteStream | null = null;
  private byteSize = 0;
  private lineCount = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private closed = false;

  constructor(
    private readonly executionId: string,
    private readonly logFilePath: string,
  ) {}

  /**
   * Opens the log file for appending. Creates parent directories if needed.
   * Starts the periodic DB flush timer.
   */
  open(): void {
    mkdirSync(dirname(this.logFilePath), { recursive: true });
    this.stream = createWriteStream(this.logFilePath, { flags: 'a' });

    this.flushTimer = setInterval(() => {
      if (this.dirty) {
        void this.flushToDb();
      }
    }, DB_FLUSH_INTERVAL_MS);
  }

  /**
   * Writes a chunk of output to the log file.
   * Tracks byte size and line count for DB metadata.
   *
   * @param chunk - Raw string output from child process
   * @param stream - Source stream identifier ('stdout' | 'stderr' | 'system')
   */
  write(chunk: string, stream: 'stdout' | 'stderr' | 'system' = 'stdout'): void {
    if (this.closed || !this.stream) return;

    // Prefix each line with stream tag for SSE log viewer parsing
    const prefixed = chunk
      .split('\n')
      .map((line) => (line ? `[${stream}] ${line}` : ''))
      .join('\n');

    const buf = Buffer.from(prefixed, 'utf-8');
    this.stream.write(buf);

    this.byteSize += buf.byteLength;
    // Count newlines in the raw chunk
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === '\n') this.lineCount++;
    }
    this.dirty = true;
  }

  /**
   * Writes a system-level message (execution lifecycle events).
   */
  writeSystem(message: string): void {
    this.write(`${message}\n`, 'system');
  }

  /**
   * Flushes final stats to DB and closes the file stream.
   * Returns the final byte/line counts.
   */
  async close(): Promise<LogWriterStats> {
    this.closed = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final DB flush
    await this.flushToDb();

    // Close file stream
    if (this.stream) {
      await new Promise<void>((resolve) => {
        this.stream!.end(resolve);
      });
      this.stream = null;
    }

    return { byteSize: this.byteSize, lineCount: this.lineCount };
  }

  /** Current stats (for output limit checks) */
  get stats(): LogWriterStats {
    return { byteSize: this.byteSize, lineCount: this.lineCount };
  }

  // --- Private ---

  private async flushToDb(): Promise<void> {
    this.dirty = false;
    await db
      .update(executions)
      .set({
        logByteSize: this.byteSize,
        logLineCount: this.lineCount,
        logUpdatedAt: new Date(),
      })
      .where(eq(executions.id, this.executionId));
  }
}

/**
 * Resolves the log file path for a given execution.
 * Format: {LOG_DIR}/{YYYY}/{MM}/{executionId}.log
 */
export function resolveLogPath(executionId: string): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  return join(config.LOG_DIR, yyyy, mm, `${executionId}.log`);
}
```

**Key design decisions**:

- Appends `[stdout]` / `[stderr]` / `[system]` prefixes per line for SSE parser differentiation
- DB flush every 5 seconds (not per-write) to avoid database pressure on high-output executions
- `close()` returns final stats for the execution record's finalization step
- Log path uses `{YYYY}/{MM}` partitioning to prevent single-directory file count blowup

---

### Step A3: Heartbeat Timer

**File**: `src/lib/worker/heartbeat.ts`
**Purpose**: Updates `heartbeat_at` every 30 seconds for a running execution. Enables stale job detection by pg-boss or external reaper.
**Depends on**: `src/lib/db/index.ts`, `src/lib/db/schema.ts`

```typescript
// src/lib/worker/heartbeat.ts

import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const HEARTBEAT_INTERVAL_MS = 30_000;

export class ExecutionHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly executionId: string) {}

  /** Start the 30-second heartbeat loop. */
  start(): void {
    // Immediate first heartbeat
    void this.beat();

    this.timer = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Stop the heartbeat timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async beat(): Promise<void> {
    try {
      await db
        .update(executions)
        .set({ heartbeatAt: new Date() })
        .where(eq(executions.id, this.executionId));
    } catch (err) {
      // Log but do not throw -- heartbeat failure should not crash execution
      console.error(`[heartbeat] Failed for execution ${this.executionId}:`, err);
    }
  }
}
```

---

### Step A4: Execution Runner

**File**: `src/lib/worker/execution-runner.ts`
**Purpose**: Core orchestrator. Resolves args, selects the appropriate adapter based on `interaction_mode` + agent binary, spawns the process via the adapter, tracks output/limits, and finalizes with a `WHERE status = 'running'` guard against cancellation races.
**Depends on**: Steps A1-A3, all adapter modules (Section B), `src/lib/services/agent-service.ts`, `src/lib/services/capability-service.ts`

```typescript
// src/lib/worker/execution-runner.ts

import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
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
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';
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
  // Note: workingDir is on the agents table, not agentCapabilities.
  // Falls back to '/tmp' if not set on the agent.
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
    resolvedPrompt = interpolatePrompt(capability.promptTemplate!, execution.args);
    // Store resolved prompt on execution record
    await db
      .update(executions)
      .set({ prompt: resolvedPrompt })
      .where(eq(executions.id, executionId));
  } else {
    resolvedArgs = buildCommandArgs(capability.commandTokens!, execution.args);
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
    // Resume existing session
    logWriter.writeSystem(`Resuming session: ${execution.sessionRef}`);
    managedProcess = adapter.resume(execution.sessionRef, resolvedPrompt!, spawnOpts);
  } else if (execution.mode === 'prompt') {
    // New prompt-mode execution
    managedProcess = adapter.spawn(resolvedPrompt!, spawnOpts);
  } else {
    // Template-mode execution (generic adapter)
    managedProcess = adapter.spawn(resolvedArgs!.join(' '), spawnOpts);
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

    // Extract session ID from first output (adapter-specific)
    if (!sessionId) {
      sessionId = adapter.extractSessionId(chunk);
      if (sessionId) {
        void db
          .update(executions)
          .set({ sessionRef: sessionId })
          .where(eq(executions.id, executionId));
      }
    }

    // Check output limit
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
  // WHERE status = 'running' prevents overwriting a concurrent cancellation
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
    // Check if it was cancelled and finalize accordingly
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
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = args[key];
    if (value === undefined) return `{{${key}}}`; // leave unresolved placeholders
    return String(value);
  });
}

async function loadExecution(id: string): Promise<Execution> {
  const [row] = await db.select().from(executions).where(eq(executions.id, id)).limit(1);

  if (!row) throw new Error(`Execution not found: ${id}`);
  return row;
}
```

**Key design decisions**:

- `WHERE status = 'running'` guard on finalization prevents overwriting a concurrent `cancelling` state set by the cancel API
- If the guard returns 0 rows, the runner checks current status and transitions `cancelling -> cancelled`
- Session resume uses `adapter.resume()` when `parentExecutionId` and `sessionRef` are both present
- `extractSessionId` is called on every output chunk until the first session ID is captured
- Timeout uses SIGTERM with a 5-second grace period before SIGKILL

---

### Step A5: Adapter Factory

**File**: `src/lib/worker/adapters/adapter-factory.ts`
**Purpose**: Selects the correct adapter based on `interaction_mode` and agent binary name.
**Depends on**: All adapter modules

```typescript
// src/lib/worker/adapters/adapter-factory.ts

import type { AgentAdapter } from '@/lib/worker/adapters/types';
import { ClaudeAdapter } from '@/lib/worker/adapters/claude-adapter';
import { CodexAdapter } from '@/lib/worker/adapters/codex-adapter';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import { TemplateAdapter } from '@/lib/worker/adapters/template-adapter';
import type { Agent, AgentCapability } from '@/lib/types';

/** Maps agent binary basenames to their prompt-mode adapter class. */
const PROMPT_ADAPTER_MAP: Record<string, new () => AgentAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  gemini: GeminiAdapter,
};

/**
 * Selects the correct adapter based on interaction_mode and agent binary.
 * Template mode always uses TemplateAdapter.
 * Prompt mode selects by agent binary basename.
 */
export function selectAdapter(agent: Agent, capability: AgentCapability): AgentAdapter {
  if (capability.interactionMode === 'template') {
    return new TemplateAdapter();
  }

  // Extract binary basename: "/usr/bin/claude" -> "claude"
  const binaryName = agent.binaryPath.split('/').pop()?.toLowerCase() ?? '';

  const AdapterClass = PROMPT_ADAPTER_MAP[binaryName];
  if (!AdapterClass) {
    throw new Error(
      `No adapter found for agent binary "${binaryName}". ` +
        `Supported: ${Object.keys(PROMPT_ADAPTER_MAP).join(', ')}`,
    );
  }

  return new AdapterClass();
}
```

---

## Section B: Bidirectional Adapters

### Step B1: Adapter Types

**File**: `src/lib/worker/adapters/types.ts`
**Purpose**: Shared interface for all agent adapters and the managed process handle.
**Depends on**: Nothing (leaf types module)

```typescript
// src/lib/worker/adapters/types.ts

// --- SpawnOpts ---

export interface SpawnOpts {
  cwd: string;
  env: Record<string, string>;
  executionId: string;
  timeoutSec: number;
  maxOutputBytes: number;
}

// --- ManagedProcess ---

/**
 * Handle returned by adapter.spawn() / adapter.resume().
 * Provides a uniform interface for process lifecycle regardless of the
 * underlying protocol (NDJSON, JSON-RPC, tmux).
 */
export interface ManagedProcess {
  /** OS PID of the child process (or tmux server PID for tmux-only adapters) */
  pid: number;
  /** tmux session name (all agents run inside tmux for web terminal access) */
  tmuxSession: string;
  /** Send a signal to the child process */
  kill: (signal: NodeJS.Signals) => void;
  /** Register a callback for process output (stdout for NDJSON/JSON-RPC, capture-pane for tmux) */
  onData: (cb: (chunk: string) => void) => void;
  /** Register a callback for process exit */
  onExit: (cb: (code: number | null) => void) => void;
}

// --- AgentAdapter ---

/**
 * All adapters implement this interface. The execution runner calls spawn()
 * or resume() and receives a ManagedProcess handle.
 *
 * Optional methods (sendMessage, interrupt) are only available on adapters
 * that support bidirectional communication (Claude, Codex).
 */
export interface AgentAdapter {
  /** Spawn a new agent process with the given prompt or command. */
  spawn(prompt: string, opts: SpawnOpts): ManagedProcess;

  /** Resume an existing session. Only meaningful for prompt-mode adapters. */
  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess;

  /**
   * Extract external session ID from process output.
   * Called on each output chunk until a session ID is found.
   * Returns null if no session ID detected in this chunk.
   */
  extractSessionId(output: string): string | null;

  /**
   * Send a follow-up message to a running agent.
   * Only supported by Claude (NDJSON stdin) and Codex (JSON-RPC turn/start).
   */
  sendMessage?(message: string): void;

  /**
   * Interrupt the agent's current turn.
   * Claude: SIGINT. Codex: turn/interrupt JSON-RPC.
   */
  interrupt?(): void;
}
```

---

### Step B2: tmux Manager

**File**: `src/lib/worker/tmux-manager.ts`
**Purpose**: Low-level tmux operations. All adapters delegate tmux session creation/management to this module. Uses `execFileSync` (not `execSync`) to prevent shell injection -- all arguments are passed as array elements.
**Depends on**: Nothing (uses `node:child_process`)

**Security note**: This module uses `execFileSync` with arguments passed as separate array elements (never concatenated into a shell string). Session names are internally generated UUIDs, not user input. This is safe against command injection.

```typescript
// src/lib/worker/tmux-manager.ts

import { execFileSync } from 'node:child_process';

const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;

/**
 * Creates a new detached tmux session with the given name.
 * Optionally runs a command inside it.
 *
 * @param name - Unique session name (e.g., "exec-{uuid}") -- internally generated, not user input
 * @param opts.cwd - Working directory for the session
 * @param opts.command - Optional command to run (if omitted, starts a shell)
 * @param opts.cols - Terminal width (default 200)
 * @param opts.rows - Terminal height (default 50)
 */
export function createSession(
  name: string,
  opts: { cwd: string; command?: string; cols?: number; rows?: number },
): void {
  const cols = opts.cols ?? DEFAULT_COLS;
  const rows = opts.rows ?? DEFAULT_ROWS;

  const args = [
    'new-session',
    '-d',
    '-s',
    name,
    '-x',
    String(cols),
    '-y',
    String(rows),
    '-c',
    opts.cwd,
  ];

  if (opts.command) {
    args.push(opts.command);
  }

  execFileSync('tmux', args, { stdio: 'ignore' });
}

/**
 * Sends literal text to a tmux session's active pane.
 * Uses -l flag to prevent tmux from interpreting key names.
 */
export function sendInput(name: string, text: string): void {
  execFileSync('tmux', ['send-keys', '-t', name, '-l', text], {
    stdio: 'ignore',
  });
}

/** Sends an Enter keypress to the session. */
export function pressEnter(name: string): void {
  execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], {
    stdio: 'ignore',
  });
}

/**
 * Captures the tmux pane content (scrollback buffer).
 *
 * @param name - Session name
 * @param historyLines - Number of history lines to capture (default 1000)
 * @returns The captured text content
 */
export function capturePane(name: string, historyLines = 1000): string {
  return execFileSync('tmux', ['capture-pane', '-t', name, '-p', '-S', `-${historyLines}`], {
    encoding: 'utf-8',
  });
}

/** Sets up pipe-pane to redirect all output to a log file. */
export function pipePaneToFile(name: string, logFilePath: string): void {
  execFileSync('tmux', ['pipe-pane', '-t', name, '-o', `cat >> ${logFilePath}`], {
    stdio: 'ignore',
  });
}

/** Checks whether a tmux session with the given name exists. */
export function hasSession(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Kills a tmux session. */
export function killSession(name: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  } catch {
    // Session may already be dead -- ignore
  }
}

/** Resizes the tmux window for a session. */
export function resizeSession(name: string, cols: number, rows: number): void {
  execFileSync('tmux', ['resize-window', '-t', name, '-x', String(cols), '-y', String(rows)], {
    stdio: 'ignore',
  });
}

/** Lists all active tmux session names. */
export function listSessions(): string[] {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return []; // tmux server not running
  }
}

/**
 * Sends a command to a tmux session by typing it and pressing Enter.
 * Used when the session is created empty and the command must be sent after
 * pipe-pane setup.
 */
export function sendCommand(name: string, command: string): void {
  sendInput(name, command);
  pressEnter(name);
}
```

---

### Step B3: Claude Adapter

**File**: `src/lib/worker/adapters/claude-adapter.ts`
**Purpose**: Bidirectional stream-json adapter for Claude Code CLI. Spawns Claude inside tmux, communicates via NDJSON over stdin/stdout, supports multi-turn follow-up messages and session resume.
**Depends on**: `types.ts`, `tmux-manager.ts`

```typescript
// src/lib/worker/adapters/claude-adapter.ts

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';

/**
 * Claude Code adapter using the stream-json bidirectional protocol.
 *
 * Spawn:  claude -p --input-format stream-json --output-format stream-json
 *         --verbose --permission-mode bypassPermissions
 *
 * Input:  NDJSON on stdin  -> {"type":"user","message":{"role":"user","content":"..."}}
 * Output: NDJSON on stdout -> system (init), assistant, stream_event, result
 *
 * Resume: --resume <sessionId>
 */
export class ClaudeAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private tmuxSessionName = '';

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, []);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, ['--resume', sessionRef]);
  }

  extractSessionId(output: string): string | null {
    // Parse NDJSON lines looking for system init message
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          return parsed.session_id;
        }
      } catch {
        // Not valid JSON -- skip (may be partial line)
      }
    }
    return null;
  }

  sendMessage(message: string): void {
    if (!this.childProcess?.stdin?.writable) {
      throw new Error('Claude process stdin is not writable');
    }

    const ndjsonMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
      session_id: 'default',
      parent_tool_use_id: null,
    });

    this.childProcess.stdin.write(ndjsonMessage + '\n');
  }

  interrupt(): void {
    this.childProcess?.kill('SIGINT');
  }

  // --- Private ---

  private launch(prompt: string, opts: SpawnOpts, extraFlags: string[]): ManagedProcess {
    this.tmuxSessionName = `claude-${opts.executionId}`;

    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    // Build Claude CLI arguments
    const claudeArgs = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      ...extraFlags,
    ];

    // Create tmux session first (for web terminal access)
    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    // Spawn Claude process with direct stdio (NOT inside tmux command)
    // The tmux session is used for web terminal attach, but the actual
    // process uses direct child_process.spawn for reliable stdin/stdout
    this.childProcess = nodeSpawn('claude', claudeArgs, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Send initial prompt as first NDJSON message on stdin
    const initialMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: 'default',
      parent_tool_use_id: null,
    });
    this.childProcess.stdin!.write(initialMessage + '\n');

    // Wire stdout
    this.childProcess.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    // Wire stderr (capture as output too, for error visibility)
    this.childProcess.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    // Wire exit
    this.childProcess.on('exit', (code) => {
      // Clean up tmux session on process exit
      tmux.killSession(this.tmuxSessionName);
      for (const cb of exitCallbacks) cb(code);
    });

    return {
      pid: this.childProcess.pid!,
      tmuxSession: this.tmuxSessionName,
      kill: (signal) => this.childProcess?.kill(signal),
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }
}
```

**Key design decisions**:

- Claude runs via `child_process.spawn` (not inside the tmux command) for reliable NDJSON stdin/stdout -- tmux is created alongside for web terminal access
- Initial prompt is sent as the first NDJSON message on stdin (not as a CLI argument)
- `sendMessage()` writes additional NDJSON user messages to stdin for multi-turn conversations
- `interrupt()` sends SIGINT, which Claude treats as a turn cancellation
- Session resume adds `--resume <sessionRef>` to CLI flags
- `--permission-mode bypassPermissions` avoids interactive permission prompts (required for headless)
- Session ID extracted from the `system.init` NDJSON message on stdout

---

### Step B4: Codex Adapter

**File**: `src/lib/worker/adapters/codex-adapter.ts`
**Purpose**: Bidirectional JSON-RPC 2.0 adapter for Codex CLI via `codex app-server`. Manages the initialize handshake, thread lifecycle, and message sending via JSON-RPC requests/notifications.
**Depends on**: `types.ts`, `tmux-manager.ts`

```typescript
// src/lib/worker/adapters/codex-adapter.ts

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';

// --- JSON-RPC Types ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

// --- Adapter ---

/**
 * Codex CLI adapter using the app-server JSON-RPC 2.0 protocol.
 *
 * Spawn:      codex app-server
 * Handshake:  -> initialize (request) -> initialized (notification)
 * Start:      -> thread/start { model, cwd, approvalPolicy }
 * Send turn:  -> turn/start { threadId, input: [{ type:"text", text }] }
 * Steer:      -> turn/steer { threadId, turnId, input: [...] }
 * Interrupt:  -> turn/interrupt { threadId, turnId }
 * Resume:     -> thread/resume { threadId }
 *
 * Notifications from server:
 *   <- item/agentMessage/delta (streaming text)
 *   <- turn/completed
 *   <- item/commandExecution/outputDelta
 *   <- item/commandExecution/requestApproval
 */
export class CodexAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private tmuxSessionName = '';
  private requestId = 0;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private buffer = '';

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, false);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.threadId = sessionRef;
    return this.launch(prompt, opts, true);
  }

  extractSessionId(output: string): string | null {
    // Thread ID is extracted from thread/start response
    // Already handled internally via JSON-RPC response parsing
    return this.threadId;
  }

  sendMessage(message: string): void {
    if (!this.threadId) {
      throw new Error('No active thread. Cannot send message.');
    }

    this.sendRequest('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: message }],
    });
  }

  interrupt(): void {
    if (!this.threadId || !this.turnId) return;

    this.sendRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    });
  }

  // --- Private ---

  private launch(prompt: string, opts: SpawnOpts, isResume: boolean): ManagedProcess {
    this.tmuxSessionName = `codex-${opts.executionId}`;

    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    // Create tmux session for web terminal access
    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    // Spawn codex app-server
    this.childProcess = nodeSpawn('codex', ['app-server'], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Parse incoming JSON-RPC messages from stdout
    this.childProcess.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');

      // Process complete lines (JSON-RPC uses newline-delimited messages)
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const msg = JSON.parse(line);
          this.handleJsonRpcMessage(msg, dataCallbacks);
        } catch {
          // Raw text output -- forward as-is
          for (const cb of dataCallbacks) cb(line + '\n');
        }
      }
    });

    this.childProcess.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    this.childProcess.on('exit', (code) => {
      tmux.killSession(this.tmuxSessionName);
      for (const cb of exitCallbacks) cb(code);
    });

    // Perform initialization handshake then start thread
    this.initializeAndStart(prompt, opts, isResume);

    return {
      pid: this.childProcess.pid!,
      tmuxSession: this.tmuxSessionName,
      kill: (signal) => this.childProcess?.kill(signal),
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  private initializeAndStart(prompt: string, opts: SpawnOpts, isResume: boolean): void {
    // Step 1: Initialize handshake
    this.sendRequest('initialize', {
      protocolVersion: '1.0',
      clientInfo: { name: 'agent-monitor', version: '1.0.0' },
    });

    // Step 2: Send initialized notification
    this.sendNotification('initialized');

    // Step 3: Start or resume thread
    if (isResume && this.threadId) {
      this.sendRequest('thread/resume', {
        threadId: this.threadId,
      });
    } else {
      this.sendRequest('thread/start', {
        model: 'codex-mini',
        cwd: opts.cwd,
        approvalPolicy: 'auto-edit',
      });
    }

    // Step 4: Send initial turn with prompt
    // Note: thread/start response will provide threadId.
    // For simplicity, we queue the turn/start after a short delay
    // to allow the thread/start response to arrive.
    // In production, this should be event-driven via response handling.
    setTimeout(() => {
      if (this.threadId) {
        this.sendRequest('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text: prompt }],
        });
      }
    }, 500);
  }

  private handleJsonRpcMessage(
    msg: Record<string, unknown>,
    dataCallbacks: Array<(chunk: string) => void>,
  ): void {
    // JSON-RPC response (has 'id' + 'result')
    if ('id' in msg && 'result' in msg) {
      const result = msg.result as Record<string, unknown>;

      // thread/start response contains threadId
      if (result.threadId && typeof result.threadId === 'string') {
        this.threadId = result.threadId;
      }

      // turn/start response contains turnId
      if (result.turnId && typeof result.turnId === 'string') {
        this.turnId = result.turnId;
      }
      return;
    }

    // JSON-RPC notification (has 'method', no 'id')
    if ('method' in msg) {
      const method = msg.method as string;
      const params = (msg.params ?? {}) as Record<string, unknown>;

      switch (method) {
        case 'item/agentMessage/delta': {
          // Streaming text from the agent
          const delta = params.delta as string | undefined;
          if (delta) {
            for (const cb of dataCallbacks) cb(delta);
          }
          break;
        }
        case 'item/commandExecution/outputDelta': {
          // Tool execution output
          const output = params.delta as string | undefined;
          if (output) {
            for (const cb of dataCallbacks) cb(output);
          }
          break;
        }
        case 'turn/completed': {
          // Turn finished -- update turnId
          this.turnId = null;
          const summary = '[codex] Turn completed\n';
          for (const cb of dataCallbacks) cb(summary);
          break;
        }
        case 'item/commandExecution/requestApproval': {
          // Auto-approve (we use auto-edit policy)
          const approvalId = params.id as string;
          if (approvalId) {
            this.sendRequest('item/commandExecution/approve', {
              id: approvalId,
            });
          }
          break;
        }
        default: {
          // Forward unknown notifications as text
          const text = `[codex:${method}] ${JSON.stringify(params)}\n`;
          for (const cb of dataCallbacks) cb(text);
        }
      }
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>): void {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    };
    this.writeMessage(request);
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params && { params }),
    };
    this.writeMessage(notification);
  }

  private writeMessage(msg: JsonRpcMessage): void {
    if (!this.childProcess?.stdin?.writable) return;
    this.childProcess.stdin.write(JSON.stringify(msg) + '\n');
  }
}
```

**Key design decisions**:

- Full JSON-RPC 2.0 protocol: request (with `id`), notification (without `id`), response (matching `id`)
- Initialize handshake sends `initialize` request followed by `initialized` notification
- `thread/start` creates a new conversation thread; response provides `threadId`
- `turn/start` sends a user message within the thread; response provides `turnId`
- `turn/interrupt` stops the current turn (requires both `threadId` and `turnId`)
- `turn/steer` can inject a message mid-turn (not exposed yet, but the protocol supports it)
- `item/commandExecution/requestApproval` is auto-approved since we set `approvalPolicy: 'auto-edit'`
- Thread resume uses `thread/resume` with the stored `threadId` from the DB

---

### Step B5: Gemini Adapter

**File**: `src/lib/worker/adapters/gemini-adapter.ts`
**Purpose**: Pseudo-bidirectional adapter for Gemini CLI using tmux send-keys / capture-pane. No native bidirectional protocol -- all communication goes through the terminal layer.
**Depends on**: `types.ts`, `tmux-manager.ts`

```typescript
// src/lib/worker/adapters/gemini-adapter.ts

import * as tmux from '@/lib/worker/tmux-manager';
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';

const POLL_INTERVAL_MS = 500;

/**
 * Gemini CLI adapter using tmux for pseudo-bidirectional communication.
 *
 * Gemini has NO native bidirectional protocol. We manage it through tmux:
 * - Spawn: `gemini -i "prompt"` inside tmux session (interactive mode)
 * - Send:  `tmux send-keys -t "session" -l "message"` + Enter
 * - Read:  `tmux capture-pane -t "session" -p -S -1000`
 * - Detect completion: poll for ">" prompt (heuristic)
 *
 * Resume: Gemini sessions persist in tmux. Use `--resume latest` for
 *         Gemini's built-in session resume, or reuse the existing tmux session.
 */
export class GeminiAdapter implements AgentAdapter {
  private tmuxSessionName = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastCaptureLength = 0;

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, []);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    // Gemini resume: --resume latest or --resume <index>
    return this.launch(prompt, opts, ['--resume', 'latest']);
  }

  extractSessionId(_output: string): string | null {
    // Gemini does not emit a structured session ID.
    // The tmux session name serves as the session reference.
    return this.tmuxSessionName;
  }

  sendMessage(message: string): void {
    if (!tmux.hasSession(this.tmuxSessionName)) {
      throw new Error(`Gemini tmux session "${this.tmuxSessionName}" not found`);
    }
    tmux.sendInput(this.tmuxSessionName, message);
    tmux.pressEnter(this.tmuxSessionName);
  }

  interrupt(): void {
    // Send Ctrl+C via tmux
    if (tmux.hasSession(this.tmuxSessionName)) {
      tmux.sendInput(this.tmuxSessionName, '\x03'); // ETX = Ctrl+C
    }
  }

  // --- Private ---

  private launch(prompt: string, opts: SpawnOpts, extraFlags: string[]): ManagedProcess {
    this.tmuxSessionName = `gemini-${opts.executionId}`;

    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    // Build gemini command: gemini [extraFlags] -i "prompt"
    // Interactive mode (-i): processes initial prompt, stays alive for follow-ups
    const geminiCmd = ['gemini', ...extraFlags, '-i', prompt].join(' ');

    // Create tmux session with the gemini command running inside
    tmux.createSession(this.tmuxSessionName, {
      cwd: opts.cwd,
      command: geminiCmd,
    });

    // Set up pipe-pane to capture output to a temp file for the log writer
    const pipeFile = `/tmp/gemini-${opts.executionId}.pipe`;
    tmux.pipePaneToFile(this.tmuxSessionName, pipeFile);

    // Poll tmux capture-pane for new output
    this.pollTimer = setInterval(() => {
      if (!tmux.hasSession(this.tmuxSessionName)) {
        // Session ended -- notify exit
        this.stopPolling();
        for (const cb of exitCallbacks) cb(0);
        return;
      }

      const captured = tmux.capturePane(this.tmuxSessionName);
      if (captured.length > this.lastCaptureLength) {
        const newContent = captured.slice(this.lastCaptureLength);
        this.lastCaptureLength = captured.length;
        for (const cb of dataCallbacks) cb(newContent);
      }
    }, POLL_INTERVAL_MS);

    // Determine PID of the process running inside the tmux pane
    let pid = 0;
    try {
      const { execFileSync } = require('node:child_process');
      const pidStr = execFileSync(
        'tmux',
        ['display-message', '-t', this.tmuxSessionName, '-p', '#{pane_pid}'],
        { encoding: 'utf-8' },
      ).trim();
      pid = parseInt(pidStr, 10) || 0;
    } catch {
      // Fallback: PID unknown
    }

    return {
      pid,
      tmuxSession: this.tmuxSessionName,
      kill: (signal) => {
        this.stopPolling();
        if (pid > 0) {
          try {
            process.kill(pid, signal);
          } catch {
            // Process may already be dead
          }
        }
        tmux.killSession(this.tmuxSessionName);
      },
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
```

**Key design decisions**:

- Gemini runs entirely inside tmux -- no direct stdio from Node.js
- Output captured via 500ms polling of `tmux capture-pane` (incremental: only new content since last capture)
- `pipe-pane` also writes to a temp file for the SSE log streaming endpoint to tail
- Completion detection is heuristic-based (polling for the `>` prompt) -- inherently less reliable than Claude/Codex
- Session "ID" is the tmux session name itself (Gemini has no native session UUID)
- Resume uses `--resume latest` flag which uses Gemini's built-in session listing
- `sendMessage()` uses `tmux send-keys -l` (literal flag) to prevent key interpretation
- `interrupt()` sends Ctrl+C (`\x03`) via tmux

---

### Step B6: Template Adapter

**File**: `src/lib/worker/adapters/template-adapter.ts`
**Purpose**: Simple fire-and-forget adapter for non-AI CLI tools (git, docker, etc.). No bidirectional communication. Spawns inside tmux for consistency with the web terminal feature.
**Depends on**: `types.ts`, `tmux-manager.ts`

```typescript
// src/lib/worker/adapters/template-adapter.ts

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';

/**
 * Simple adapter for template-mode capabilities (non-AI CLI tools).
 *
 * - Spawns with shell: false (arguments as separate argv elements)
 * - stdin ignored (no bidirectional)
 * - stdout/stderr piped to log writer
 * - Short-lived (seconds to minutes)
 * - Runs inside tmux for web terminal consistency
 */
export class TemplateAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private tmuxSessionName = '';

  spawn(commandStr: string, opts: SpawnOpts): ManagedProcess {
    this.tmuxSessionName = `exec-${opts.executionId}`;

    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    // Parse command string back to binary + args
    // commandStr is "arg0 arg1 arg2" from buildCommandArgs().join(' ')
    const tokens = commandStr.split(' ');
    const binary = tokens[0];
    const args = tokens.slice(1);

    // Create tmux session for web terminal access
    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    // Spawn the process directly (not via tmux command)
    this.childProcess = nodeSpawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored
      shell: false,
    });

    this.childProcess.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    this.childProcess.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    this.childProcess.on('exit', (code) => {
      tmux.killSession(this.tmuxSessionName);
      for (const cb of exitCallbacks) cb(code);
    });

    return {
      pid: this.childProcess.pid!,
      tmuxSession: this.tmuxSessionName,
      kill: (signal) => this.childProcess?.kill(signal),
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  resume(_sessionRef: string, _prompt: string, _opts: SpawnOpts): ManagedProcess {
    throw new Error('Template adapter does not support session resume');
  }

  extractSessionId(_output: string): string | null {
    return null; // Template mode has no session concept
  }

  // No sendMessage -- template mode is fire-and-forget
  // No interrupt -- use kill(SIGTERM) directly
}
```

---

## Section B7: Execution Service + API Routes

> **Note**: These steps implement the execution service and all execution-related API routes.
> Phase 4b's frontend depends on these being complete. Routes reference `planning/04-phases.md:254-265`.
> SSE log streaming uses `fs.watch` for live log tailing per `planning/02-architecture.md` Section 6.

### Step B7a: Execution Service

**File**: `src/lib/services/execution-service.ts`
**Purpose**: CRUD + cancel operations for executions. Validates capability + args, inserts queued executions, handles cancellation with status guard.
**Depends on**: `src/lib/db/index.ts`, `src/lib/db/schema.ts`, `src/lib/types.ts`, `src/lib/errors.ts`, `src/lib/state-machines.ts`, `src/lib/services/agent-service.ts`, `src/lib/services/capability-service.ts`

```typescript
// src/lib/services/execution-service.ts

import { eq, and, desc, sql, count } from 'drizzle-orm';
import { db } from '@/lib/db';
import { executions, tasks, agents, agentCapabilities, taskEvents } from '@/lib/db/schema';
import { isValidExecutionTransition } from '@/lib/state-machines';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/errors';
import type { Execution, ExecutionStatus, NewExecution, Agent, AgentCapability } from '@/lib/types';

// --- Types ---

export interface CreateExecutionInput {
  taskId: string;
  agentId: string;
  capabilityId: string;
  args?: Record<string, unknown>;
}

export interface ListExecutionsInput {
  taskId?: string;
  agentId?: string;
  status?: ExecutionStatus;
  page?: number;
  pageSize?: number;
}

export interface ExecutionWithDetails extends Execution {
  agent: Pick<Agent, 'id' | 'name' | 'slug'>;
  capability: Pick<AgentCapability, 'id' | 'label' | 'key' | 'interactionMode'>;
}

// --- Functions ---

/**
 * Creates a new execution in 'queued' status.
 * Validates that the agent, capability, and task all exist.
 * Copies the capability's interactionMode to execution.mode for history preservation.
 * If the parent task is 'todo', transitions it to 'in_progress'.
 */
export async function createExecution(input: CreateExecutionInput): Promise<Execution> {
  // Validate references exist
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
  if (!agent) throw new NotFoundError(`Agent ${input.agentId} not found`);

  const [capability] = await db
    .select()
    .from(agentCapabilities)
    .where(
      and(
        eq(agentCapabilities.id, input.capabilityId),
        eq(agentCapabilities.agentId, input.agentId),
      ),
    )
    .limit(1);
  if (!capability)
    throw new NotFoundError(
      `Capability ${input.capabilityId} not found for agent ${input.agentId}`,
    );

  const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  if (!task) throw new NotFoundError(`Task ${input.taskId} not found`);

  // Check per-agent concurrency limit
  const [{ runningCount }] = await db
    .select({ runningCount: count() })
    .from(executions)
    .where(
      and(
        eq(executions.agentId, input.agentId),
        sql`${executions.status} IN ('queued', 'running')`,
      ),
    );
  if (runningCount >= agent.maxConcurrent) {
    throw new ConflictError(
      `Agent "${agent.name}" is at max concurrency (${agent.maxConcurrent}). Wait for current executions to complete.`,
    );
  }

  // Insert execution
  const [execution] = await db
    .insert(executions)
    .values({
      taskId: input.taskId,
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      args: input.args ?? {},
      mode: capability.interactionMode,
      status: 'queued',
    })
    .returning();

  // Auto-transition task from 'todo' to 'in_progress'
  if (task.status === 'todo') {
    await db
      .update(tasks)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
  }

  // Audit trail
  await db.insert(taskEvents).values({
    taskId: input.taskId,
    actorType: 'user',
    actorId: execution.requestedBy,
    eventType: 'execution_created',
    payload: { executionId: execution.id, capabilityId: input.capabilityId },
  });

  return execution;
}

/**
 * Sets a running/queued execution to 'cancelling'.
 * The worker detects this and sends SIGTERM, then SIGKILL after grace period.
 */
export async function cancelExecution(executionId: string): Promise<Execution> {
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);
  if (!execution) throw new NotFoundError(`Execution ${executionId} not found`);

  if (!isValidExecutionTransition(execution.status, 'cancelling')) {
    throw new ConflictError(`Cannot cancel execution in "${execution.status}" status`);
  }

  const [updated] = await db
    .update(executions)
    .set({ status: 'cancelling' })
    .where(and(eq(executions.id, executionId), sql`${executions.status} IN ('queued', 'running')`))
    .returning();

  if (!updated) throw new ConflictError('Execution status changed concurrently');

  return updated;
}

/**
 * Returns a single execution with joined agent and capability details.
 */
export async function getExecutionById(executionId: string): Promise<ExecutionWithDetails> {
  const rows = await db
    .select({
      execution: executions,
      agentId: agents.id,
      agentName: agents.name,
      agentSlug: agents.slug,
      capId: agentCapabilities.id,
      capLabel: agentCapabilities.label,
      capKey: agentCapabilities.key,
      capMode: agentCapabilities.interactionMode,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .innerJoin(agentCapabilities, eq(executions.capabilityId, agentCapabilities.id))
    .where(eq(executions.id, executionId))
    .limit(1);

  if (rows.length === 0) throw new NotFoundError(`Execution ${executionId} not found`);

  const row = rows[0];
  return {
    ...row.execution,
    agent: { id: row.agentId, name: row.agentName, slug: row.agentSlug },
    capability: {
      id: row.capId,
      label: row.capLabel,
      key: row.capKey,
      interactionMode: row.capMode,
    },
  };
}

/**
 * Lists executions with pagination. Filterable by taskId, agentId, and status.
 */
export async function listExecutions(input: ListExecutionsInput = {}): Promise<{
  data: Execution[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const conditions = [];
  if (input.taskId) conditions.push(eq(executions.taskId, input.taskId));
  if (input.agentId) conditions.push(eq(executions.agentId, input.agentId));
  if (input.status) conditions.push(eq(executions.status, input.status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, [{ total }]] = await Promise.all([
    db
      .select()
      .from(executions)
      .where(where)
      .orderBy(desc(executions.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(executions).where(where),
  ]);

  return { data, total, page, pageSize };
}
```

**Key design decisions**:

- Concurrency check before enqueue: count running/queued executions per agent, reject if at `maxConcurrent`
- `mode` is copied from `capability.interactionMode` at queue time (denormalized for history)
- Cancel uses `WHERE status IN ('queued', 'running')` guard to prevent race conditions
- Task auto-transitions `todo -> in_progress` on first execution creation
- `getExecutionById` joins agent + capability for the detail view

---

### Step B7b: Execution API Routes

**File**: `src/app/api/executions/route.ts`
**Purpose**: List and create executions.
**Depends on**: `execution-service.ts`, `api-handler.ts`

```typescript
// src/app/api/executions/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { listExecutions, createExecution } from '@/lib/services/execution-service';

/** GET /api/executions — List executions (paginated, filterable) */
export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const result = await listExecutions({
    taskId: url.searchParams.get('taskId') ?? undefined,
    agentId: url.searchParams.get('agentId') ?? undefined,
    status: (url.searchParams.get('status') as any) ?? undefined,
    page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
    pageSize: url.searchParams.has('pageSize')
      ? Number(url.searchParams.get('pageSize'))
      : undefined,
  });
  return NextResponse.json({
    data: result.data,
    meta: { total: result.total, page: result.page, pageSize: result.pageSize },
  });
});

/** POST /api/executions — Create a new execution */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const execution = await createExecution(body);
  return NextResponse.json({ data: execution }, { status: 201 });
});
```

---

**File**: `src/app/api/executions/[id]/route.ts`
**Purpose**: Get execution detail with agent + capability info.

```typescript
// src/app/api/executions/[id]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getExecutionById } from '@/lib/services/execution-service';

/** GET /api/executions/:id — Execution detail with agent + capability */
export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const execution = await getExecutionById(id);
    return NextResponse.json({ data: execution });
  },
);
```

---

**File**: `src/app/api/executions/[id]/cancel/route.ts`
**Purpose**: Cancel a running or queued execution.

```typescript
// src/app/api/executions/[id]/cancel/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { cancelExecution } from '@/lib/services/execution-service';

/** POST /api/executions/:id/cancel — Set execution to 'cancelling' */
export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const execution = await cancelExecution(id);
    return NextResponse.json({ data: execution }, { status: 202 });
  },
);
```

---

**File**: `src/app/api/executions/[id]/message/route.ts`
**Purpose**: Send a follow-up message to a running execution's agent (bidirectional communication).

```typescript
// src/app/api/executions/[id]/message/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/errors';

/**
 * POST /api/executions/:id/message — Send message to running agent
 *
 * Request body: { message: string }
 *
 * The message is written to a well-known file path that the worker
 * polls for, or delivered via the adapter's sendMessage() method.
 * For P0-4, this writes the message to a sidecar file that the
 * worker's adapter picks up.
 */
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = await req.json();
    const { message } = body;

    if (!message || typeof message !== 'string') {
      throw new ValidationError('message is required and must be a string');
    }

    const [execution] = await db.select().from(executions).where(eq(executions.id, id)).limit(1);

    if (!execution) throw new NotFoundError(`Execution ${id} not found`);

    if (execution.status !== 'running') {
      throw new ConflictError(
        `Cannot send message to execution in "${execution.status}" status. Must be "running".`,
      );
    }

    // Write message to sidecar file for worker to pick up
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const msgDir = join('/tmp', 'agent-monitor-messages', id);
    mkdirSync(msgDir, { recursive: true });
    const msgFile = join(msgDir, `${Date.now()}.msg`);
    writeFileSync(msgFile, message, 'utf-8');

    return NextResponse.json({ data: { sent: true } });
  },
);
```

---

### Step B7c: SSE Log Stream Endpoint

**File**: `src/app/api/executions/[id]/logs/stream/route.ts`
**Purpose**: SSE live log tailing using `fs.watch` (inotify on Linux) with 500ms polling fallback. Sends catch-up content on connect, then streams new log lines as they're written.
**Depends on**: `src/lib/db/index.ts`, `src/lib/db/schema.ts`, `src/lib/errors.ts`

> Per `planning/02-architecture.md` Section 6: "Real-time log tailing for a single execution via `fs.watch` (Linux inotify) with 500ms polling fallback. On file growth, reads new bytes from last offset and sends as SSE events."

```typescript
// src/app/api/executions/[id]/logs/stream/route.ts

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { readFileSync, existsSync, statSync, watch, type FSWatcher } from 'node:fs';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const STATUS_POLL_INTERVAL_MS = 1_000;
const FILE_POLL_INTERVAL_MS = 500;

/**
 * GET /api/executions/:id/logs/stream — SSE live log tail
 *
 * Lifecycle:
 * 1. Connect -> send current status
 * 2. If log file exists, send catch-up content
 * 3. If execution is terminal, send 'done' and close
 * 4. Otherwise, watch log file via fs.watch + poll status every 1s
 * 5. On terminal status, flush final bytes, send 'done', close
 * 6. On client disconnect, clean up watchers/timers
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const encoder = new TextEncoder();
  let closed = false;
  let fileOffset = 0;
  let watcher: FSWatcher | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let filePollTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: Record<string, unknown>) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      }

      function cleanup() {
        closed = true;
        if (watcher) {
          watcher.close();
          watcher = null;
        }
        if (statusTimer) {
          clearInterval(statusTimer);
          statusTimer = null;
        }
        if (filePollTimer) {
          clearInterval(filePollTimer);
          filePollTimer = null;
        }
      }

      // Load execution
      const [execution] = await db.select().from(executions).where(eq(executions.id, id)).limit(1);

      if (!execution) {
        send({ type: 'error', message: `Execution ${id} not found` });
        controller.close();
        return;
      }

      // Send current status
      send({ type: 'status', status: execution.status });

      // Send catch-up content if log file exists
      const logPath = execution.logFilePath;
      if (logPath && existsSync(logPath)) {
        const content = readFileSync(logPath, 'utf-8');
        if (content.length > 0) {
          send({ type: 'catchup', content });
          fileOffset = Buffer.byteLength(content, 'utf-8');
        }
      }

      // If already terminal, send done and close
      if (TERMINAL_STATUSES.has(execution.status)) {
        send({ type: 'done', status: execution.status, exitCode: execution.exitCode });
        controller.close();
        cleanup();
        return;
      }

      // --- Live tailing ---

      function readNewBytes() {
        if (closed || !logPath) return;
        try {
          if (!existsSync(logPath)) return;
          const stat = statSync(logPath);
          if (stat.size <= fileOffset) return;

          const fd = require('node:fs').openSync(logPath, 'r');
          const buf = Buffer.alloc(stat.size - fileOffset);
          require('node:fs').readSync(fd, buf, 0, buf.length, fileOffset);
          require('node:fs').closeSync(fd);

          fileOffset = stat.size;
          const content = buf.toString('utf-8');

          // Parse stream prefix: [stdout], [stderr], [system]
          const lines = content.split('\n');
          for (const line of lines) {
            if (!line) continue;
            const match = line.match(/^\[(stdout|stderr|system)\] (.*)$/);
            if (match) {
              send({ type: 'log', content: match[2], stream: match[1] });
            } else {
              send({ type: 'log', content: line, stream: 'stdout' });
            }
          }
        } catch {
          // File may have been deleted or rotated
        }
      }

      // Watch log file with fs.watch (inotify on Linux)
      if (logPath && existsSync(logPath)) {
        try {
          watcher = watch(logPath, () => readNewBytes());
        } catch {
          // Fallback: fs.watch may fail on some filesystems
        }
      }

      // 500ms polling fallback (catches cases where fs.watch misses events)
      filePollTimer = setInterval(() => {
        if (!logPath) return;
        // If log file appeared after SSE started, set up watcher
        if (!watcher && existsSync(logPath)) {
          try {
            watcher = watch(logPath, () => readNewBytes());
          } catch {}
        }
        readNewBytes();
      }, FILE_POLL_INTERVAL_MS);

      // Poll execution status every 1s for terminal detection
      statusTimer = setInterval(async () => {
        if (closed) return;
        try {
          const [current] = await db
            .select({ status: executions.status, exitCode: executions.exitCode })
            .from(executions)
            .where(eq(executions.id, id))
            .limit(1);

          if (!current) {
            send({ type: 'error', message: 'Execution not found' });
            controller.close();
            cleanup();
            return;
          }

          // Send status update if changed
          send({ type: 'status', status: current.status });

          if (TERMINAL_STATUSES.has(current.status)) {
            // Flush final bytes
            readNewBytes();
            send({ type: 'done', status: current.status, exitCode: current.exitCode });
            controller.close();
            cleanup();
          }
        } catch {
          // DB error -- continue polling
        }
      }, STATUS_POLL_INTERVAL_MS);
    },

    cancel() {
      closed = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      if (filePollTimer) {
        clearInterval(filePollTimer);
        filePollTimer = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

**Key design decisions**:

- Uses `fs.watch` (Linux inotify) as primary file change notification, with 500ms polling as fallback
- Reads new bytes from last offset (not re-reading entire file) for efficiency
- Parses `[stdout]`/`[stderr]`/`[system]` prefixes written by `FileLogWriter` (Step A2)
- Status polling every 1s detects terminal states and triggers final flush + close
- Non-terminal executions only (terminal executions get catch-up + immediate done)
- Client disconnect triggers cleanup of all watchers and timers

---

### Step B7d: Log Download Endpoint

**File**: `src/app/api/executions/[id]/logs/route.ts`
**Purpose**: Full log file download.

```typescript
// src/app/api/executions/[id]/logs/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { readFileSync, existsSync } from 'node:fs';
import { NotFoundError } from '@/lib/errors';

/** GET /api/executions/:id/logs — Full log file download */
export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;

    const [execution] = await db
      .select({ logFilePath: executions.logFilePath })
      .from(executions)
      .where(eq(executions.id, id))
      .limit(1);

    if (!execution) throw new NotFoundError(`Execution ${id} not found`);

    if (!execution.logFilePath || !existsSync(execution.logFilePath)) {
      return NextResponse.json({ data: { content: '' } });
    }

    const content = readFileSync(execution.logFilePath, 'utf-8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="execution-${id}.log"`,
      },
    });
  },
);
```

---

### Step B7e: Worker Status Route

**File**: `src/app/api/workers/status/route.ts`
**Purpose**: Returns worker heartbeat status for the dashboard.

```typescript
// src/app/api/workers/status/route.ts

import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { workerHeartbeats } from '@/lib/db/schema';

/** GET /api/workers/status — Worker heartbeat check */
export const GET = withErrorBoundary(async () => {
  const workers = await db.select().from(workerHeartbeats);
  return NextResponse.json({ data: workers });
});
```

---

## Section C: WebSocket Terminal Server

### Step C1: Terminal Auth

**File**: `src/terminal/auth.ts`
**Purpose**: JWT validation for WebSocket terminal connections. Tokens are issued by the Next.js API (`POST /api/terminal/token`) and validated here during the WebSocket handshake.
**Depends on**: `src/lib/config.ts` (for `TERMINAL_JWT_SECRET`)

```typescript
// src/terminal/auth.ts

import { createHmac, timingSafeEqual } from 'node:crypto';

// --- Types ---

export interface TerminalTokenPayload {
  /** tmux session name to attach to */
  sessionName: string;
  /** User ID that requested the terminal */
  userId: string;
  /** Expiration timestamp (Unix seconds) */
  exp: number;
}

// --- Functions ---

/**
 * Creates a short-lived JWT for terminal WebSocket authentication.
 * Called by the Next.js API route `POST /api/terminal/token`.
 *
 * Token lifetime: 5 minutes (enough for the WebSocket upgrade handshake).
 */
export function createTerminalToken(
  payload: Omit<TerminalTokenPayload, 'exp'>,
  secret: string,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + 300; // 5 minutes
  const body = base64url(JSON.stringify({ ...payload, exp }));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

/**
 * Validates a terminal JWT token. Returns the payload if valid, throws otherwise.
 *
 * Checks:
 * 1. Structural validity (3 parts, valid base64url)
 * 2. Signature verification (HMAC-SHA256, timing-safe)
 * 3. Expiration (exp claim)
 */
export function verifyTerminalToken(token: string, secret: string): TerminalTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  const [header, body, sig] = parts;

  // Verify signature (timing-safe comparison)
  const expectedSig = sign(`${header}.${body}`, secret);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid token signature');
  }

  // Decode payload
  const payload = JSON.parse(
    Buffer.from(body, 'base64url').toString('utf-8'),
  ) as TerminalTokenPayload;

  // Check expiration
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

// --- Helpers ---

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}
```

**Key design decisions**:

- Minimal JWT implementation (HS256 only) -- no external library needed for this simple use case
- Timing-safe signature comparison via `timingSafeEqual` to prevent timing attacks
- 5-minute token lifetime -- enough for WebSocket upgrade, short enough to limit replay window
- Token is single-use for the connection upgrade (not stored server-side, validated on handshake)

---

### Step C2: Terminal Server

**File**: `src/terminal/server.ts`
**Purpose**: Standalone WebSocket server on port 4101. Accepts authenticated connections, attaches to tmux sessions via node-pty, and forwards PTY I/O to/from the browser. Supports multiple viewers per session.
**Depends on**: `auth.ts`, `node-pty`, `socket.io`

```typescript
// src/terminal/server.ts

import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import * as pty from 'node-pty';
import { verifyTerminalToken, type TerminalTokenPayload } from './auth';

// --- Config ---

const PORT = parseInt(process.env.TERMINAL_PORT ?? '4101', 10);
const JWT_SECRET = process.env.TERMINAL_JWT_SECRET ?? '';
const NEXT_ORIGIN = process.env.NEXT_PUBLIC_URL ?? 'http://localhost:4100';

if (!JWT_SECRET) {
  console.error('[terminal-server] TERMINAL_JWT_SECRET is required');
  process.exit(1);
}

// --- Types ---

interface SessionEntry {
  tmuxName: string;
  ptyProcess: pty.IPty;
  viewers: Set<string>; // socket IDs
}

// --- State ---

/** Maps tmux session name -> active PTY + connected viewers */
const sessions = new Map<string, SessionEntry>();

// --- HTTP + Socket.io Server ---

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Terminal server OK');
});

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: NEXT_ORIGIN,
    methods: ['GET', 'POST'],
  },
  // Increase max buffer for large terminal output bursts
  maxHttpBufferSize: 1e6, // 1MB
});

// --- Connection Handler ---

io.on('connection', (socket) => {
  // Step 1: Validate JWT from query params
  const token = socket.handshake.query.token as string | undefined;
  if (!token) {
    socket.emit('terminal:error', { message: 'Missing authentication token' });
    socket.disconnect(true);
    return;
  }

  let payload: TerminalTokenPayload;
  try {
    payload = verifyTerminalToken(token, JWT_SECRET);
  } catch (err) {
    socket.emit('terminal:error', {
      message: `Authentication failed: ${(err as Error).message}`,
    });
    socket.disconnect(true);
    return;
  }

  const { sessionName } = payload;

  // Step 2: Get or create PTY session
  let entry = sessions.get(sessionName);

  if (!entry) {
    // Spawn node-pty process that attaches to the tmux session
    try {
      const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: process.env.HOME ?? '/tmp',
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          HOME: process.env.HOME ?? '/tmp',
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
      });

      entry = {
        tmuxName: sessionName,
        ptyProcess,
        viewers: new Set(),
      };

      // Forward PTY output to ALL connected viewers
      ptyProcess.onData((data) => {
        for (const viewerId of entry!.viewers) {
          io.to(viewerId).emit('terminal:output', data);
        }
      });

      // Handle PTY exit (tmux detach or session end)
      ptyProcess.onExit(({ exitCode }) => {
        console.log(`[terminal] PTY exited for ${sessionName} (code: ${exitCode})`);
        // Notify all viewers
        for (const viewerId of entry!.viewers) {
          io.to(viewerId).emit('terminal:exit', { exitCode });
        }
        sessions.delete(sessionName);
      });

      sessions.set(sessionName, entry);
      console.log(`[terminal] Created PTY for tmux session: ${sessionName}`);
    } catch (err) {
      socket.emit('terminal:error', {
        message: `Failed to attach to session: ${(err as Error).message}`,
      });
      socket.disconnect(true);
      return;
    }
  }

  // Step 3: Add this socket as a viewer
  entry.viewers.add(socket.id);
  console.log(
    `[terminal] Viewer connected: ${socket.id} -> ${sessionName} (${entry.viewers.size} viewers)`,
  );

  // Step 4: Handle input from this viewer
  socket.on('terminal:input', (data: string) => {
    entry?.ptyProcess.write(data);
  });

  // Step 5: Handle resize from this viewer
  socket.on('terminal:resize', ({ cols, rows }: { cols: number; rows: number }) => {
    if (cols > 0 && rows > 0 && cols <= 500 && rows <= 200) {
      entry?.ptyProcess.resize(cols, rows);
    }
  });

  // Step 6: Handle disconnect
  socket.on('disconnect', () => {
    if (entry) {
      entry.viewers.delete(socket.id);
      console.log(
        `[terminal] Viewer disconnected: ${socket.id} -> ${sessionName} (${entry.viewers.size} viewers)`,
      );

      // If no viewers left, kill the PTY (tmux detaches, agent keeps running)
      if (entry.viewers.size === 0) {
        console.log(`[terminal] No viewers for ${sessionName}, killing PTY (tmux detaches)`);
        entry.ptyProcess.kill();
        sessions.delete(sessionName);
      }
    }
  });
});

// --- Startup ---

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[terminal-server] Listening on 127.0.0.1:${PORT}`);
});

// --- Graceful Shutdown ---

function shutdown(signal: string): void {
  console.log(`[terminal-server] Received ${signal}, shutting down...`);

  // Kill all PTY processes (tmux sessions continue independently)
  for (const [name, entry] of sessions) {
    console.log(`[terminal] Killing PTY for ${name}`);
    entry.ptyProcess.kill();
  }
  sessions.clear();

  io.close();
  httpServer.close(() => {
    console.log('[terminal-server] Shut down cleanly');
    process.exit(0);
  });

  // Force exit after 5s
  setTimeout(() => process.exit(1), 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

**Key design decisions**:

- **Standalone process** on port 4101 -- not embedded in Next.js (avoids middleware conflicts, separate scaling)
- **Socket.io** for WebSocket transport with automatic fallback and reconnection
- **Multi-viewer**: Multiple browser tabs can connect to the same tmux session simultaneously via the `viewers` Set
- **Graceful detach**: When the last viewer disconnects, the PTY process is killed (tmux detaches), but the agent inside tmux continues running
- **Bound to 127.0.0.1**: Not publicly accessible -- access via SSH tunnel or nginx reverse proxy with auth
- **Resize validation**: Cols/rows are range-checked to prevent abuse (max 500 cols, 200 rows)
- **Minimal env for PTY**: Only `TERM`, `COLORTERM`, `HOME`, `PATH` -- no `process.env` spread
- `node-pty` spawns `tmux attach-session -t {name}` which attaches to the session created by the adapter

---

### Step C3: PM2 Configuration

**File**: `ecosystem.config.js` (update existing)
**Purpose**: Add the terminal server as a PM2 managed process.

Add this entry to the existing `apps` array in `ecosystem.config.js`:

```javascript
{
  name: 'agent-monitor-terminal',
  script: 'pnpm',
  args: 'tsx src/terminal/server.ts',
  interpreter: 'none',
  cwd: '/home/ubuntu/projects/agent-monitor',
  env: {
    NODE_OPTIONS: '--max-old-space-size=256',
    TERMINAL_PORT: '4101',
    TERMINAL_JWT_SECRET: '${TERMINAL_JWT_SECRET}',
    NEXT_PUBLIC_URL: 'http://localhost:4100',
  },
  max_memory_restart: '512M',
}
```

---

### Step C4: Terminal Token API Route

**File**: `src/app/api/terminal/token/route.ts`
**Purpose**: Next.js API route that issues short-lived JWTs for WebSocket terminal connections. Validates that the requesting user has a session and that the target tmux session exists.
**Depends on**: `src/terminal/auth.ts`, `src/lib/api-handler.ts`

```typescript
// src/app/api/terminal/token/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createTerminalToken } from '@/terminal/auth';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { config } from '@/lib/config';
import { NotFoundError, ValidationError } from '@/lib/errors';

/**
 * POST /api/terminal/token
 *
 * Request body: { executionId: string }
 * Response:     { data: { token: string } }
 *
 * Issues a 5-minute JWT for connecting to the terminal WebSocket server.
 * The token contains the tmux session name and user ID.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const { executionId } = body;

  if (!executionId || typeof executionId !== 'string') {
    throw new ValidationError('executionId is required');
  }

  // Look up execution to get tmux session name
  const [execution] = await db
    .select({
      tmuxSessionName: executions.tmuxSessionName,
      status: executions.status,
    })
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);

  if (!execution) {
    throw new NotFoundError(`Execution ${executionId} not found`);
  }

  if (!execution.tmuxSessionName) {
    throw new ValidationError('Execution does not have a tmux session');
  }

  // Only allow terminal access for running/cancelling executions
  if (!['running', 'cancelling'].includes(execution.status)) {
    throw new ValidationError(`Cannot attach terminal to execution in "${execution.status}" state`);
  }

  const token = createTerminalToken(
    {
      sessionName: execution.tmuxSessionName,
      userId: '00000000-0000-0000-0000-000000000001', // Single-user for now
    },
    config.TERMINAL_JWT_SECRET,
  );

  return NextResponse.json({ data: { token } });
});
```

---

## Environment Variables Required

Add these to `src/lib/config.ts` Zod schema:

| Variable               | Description                                         | Default                                    |
| ---------------------- | --------------------------------------------------- | ------------------------------------------ |
| `ALLOWED_WORKING_DIRS` | Comma-separated list of allowed working directories | `/home/ubuntu/projects`                    |
| `LOG_DIR`              | Base directory for execution log files              | `/home/ubuntu/projects/agent-monitor/logs` |
| `WORKER_ID`            | Unique identifier for this worker instance          | `worker-1`                                 |
| `TERMINAL_JWT_SECRET`  | Secret for signing terminal WebSocket JWTs          | (required, no default)                     |
| `TERMINAL_PORT`        | Port for the terminal WebSocket server              | `4101`                                     |
| `NEXT_PUBLIC_URL`      | Origin URL for CORS on terminal server              | `http://localhost:4100`                    |

> **JWT_SECRET Decision (C-08 resolution)**: `TERMINAL_JWT_SECRET` is a **separate secret** from the main `JWT_SECRET` defined in Phase 1's config.ts. The terminal server runs as a standalone process and needs its own secret for short-lived WebSocket auth tokens. Add `TERMINAL_JWT_SECRET: z.string().min(16).optional()` to the Phase 1 config.ts Zod schema. When `TERMINAL_JWT_SECRET` is not set, the terminal token API route (`POST /api/terminal/token`) should fall back to `config.JWT_SECRET`. The terminal server process reads it directly from `process.env.TERMINAL_JWT_SECRET` (not from the Zod config, since it runs outside Next.js).

---

## File Summary

| Step | File Path                                          | Lines (est.) | Purpose                                              |
| ---- | -------------------------------------------------- | ------------ | ---------------------------------------------------- |
| A1   | `src/lib/worker/safety.ts`                         | ~130         | Working dir validation, env building, arg validation |
| A2   | `src/lib/worker/log-writer.ts`                     | ~120         | File-based log writer with batched DB updates        |
| A3   | `src/lib/worker/heartbeat.ts`                      | ~40          | 30-second heartbeat timer                            |
| A4   | `src/lib/worker/execution-runner.ts`               | ~180         | Core orchestrator with race-guarded finalization     |
| A5   | `src/lib/worker/adapters/adapter-factory.ts`       | ~35          | Adapter selection by mode + binary name              |
| B1   | `src/lib/worker/adapters/types.ts`                 | ~55          | AgentAdapter + ManagedProcess interfaces             |
| B2   | `src/lib/worker/tmux-manager.ts`                   | ~110         | Low-level tmux session operations                    |
| B3   | `src/lib/worker/adapters/claude-adapter.ts`        | ~140         | Stream-json NDJSON bidirectional                     |
| B4   | `src/lib/worker/adapters/codex-adapter.ts`         | ~220         | JSON-RPC 2.0 bidirectional                           |
| B5   | `src/lib/worker/adapters/gemini-adapter.ts`        | ~130         | tmux send-keys / capture-pane polling                |
| B6   | `src/lib/worker/adapters/template-adapter.ts`      | ~70          | Simple spawn for CLI tools                           |
| B7a  | `src/lib/services/execution-service.ts`            | ~170         | CRUD + cancel for executions                         |
| B7b  | `src/app/api/executions/route.ts`                  | ~30          | GET list, POST create                                |
| B7b  | `src/app/api/executions/[id]/route.ts`             | ~15          | GET detail with agent + capability                   |
| B7b  | `src/app/api/executions/[id]/cancel/route.ts`      | ~20          | POST cancel                                          |
| B7b  | `src/app/api/executions/[id]/message/route.ts`     | ~40          | POST send message                                    |
| B7c  | `src/app/api/executions/[id]/logs/stream/route.ts` | ~130         | SSE live log tail via fs.watch                       |
| B7d  | `src/app/api/executions/[id]/logs/route.ts`        | ~30          | Full log download                                    |
| B7e  | `src/app/api/workers/status/route.ts`              | ~10          | Worker heartbeat status                              |
| C1   | `src/terminal/auth.ts`                             | ~70          | JWT creation + verification                          |
| C2   | `src/terminal/server.ts`                           | ~170         | WebSocket terminal server (Socket.io + node-pty)     |
| C3   | `ecosystem.config.js`                              | update       | PM2 entry for terminal server                        |
| C4   | `src/app/api/terminal/token/route.ts`              | ~55          | Terminal token issuance API                          |

**Total estimated new code**: ~2,000 lines across 22 files.

---

## Testing Plan

### Unit Tests

| Test                                   | File                     | What It Verifies                                               |
| -------------------------------------- | ------------------------ | -------------------------------------------------------------- |
| `buildCommandArgs` substitution        | `safety.test.ts`         | `{{branch}}` replaced with validated arg value                 |
| `buildCommandArgs` missing required    | `safety.test.ts`         | Throws `ValidationError` for missing args                      |
| `buildCommandArgs` object values       | `safety.test.ts`         | Rejects objects/arrays in token positions                      |
| `validateWorkingDir` allowlist         | `safety.test.ts`         | Only dirs in `ALLOWED_WORKING_DIRS` pass                       |
| `validateWorkingDir` symlink traversal | `safety.test.ts`         | Symlink pointing outside allowlist is rejected                 |
| `buildChildEnv` no leak                | `safety.test.ts`         | Result contains only allowlisted vars, no `process.env` spread |
| Claude adapter NDJSON parse            | `claude-adapter.test.ts` | Extracts `session_id` from `system.init` message               |
| Claude adapter sendMessage             | `claude-adapter.test.ts` | Writes correct NDJSON to stdin                                 |
| Codex adapter handshake                | `codex-adapter.test.ts`  | Sends `initialize` + `initialized` in correct order            |
| Codex adapter turn lifecycle           | `codex-adapter.test.ts`  | `turn/start` sends, `turn/completed` notification parsed       |
| Gemini adapter tmux send               | `gemini-adapter.test.ts` | `sendMessage` calls `tmux send-keys` with `-l` flag            |
| TmuxManager operations                 | `tmux-manager.test.ts`   | create, kill, capturePane, hasSession                          |

### Integration Tests

| Test                                           | What It Verifies                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Create execution -> worker claims -> completes | Full lifecycle: queued -> running -> succeeded                      |
| Cancel mid-execution                           | Status transitions: running -> cancelling -> cancelled              |
| Output limit exceeded                          | SIGTERM sent when log exceeds `maxOutputBytes`                      |
| Timeout enforcement                            | SIGTERM at timeout, SIGKILL after 5s grace                          |
| Session resume                                 | New execution with `parentExecutionId` triggers adapter.resume()    |
| Send follow-up message                         | `POST /api/executions/:id/message` delivers to Claude adapter stdin |
| Terminal WebSocket auth                        | Valid JWT -> connects; expired JWT -> rejected                      |
| Multi-viewer terminal                          | Two Socket.io clients see same PTY output                           |

---

## Dependency Graph

```
                   ┌────────────────────┐
                   │ execution-runner.ts │
                   └─────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         ┌────▼────┐  ┌─────▼─────┐  ┌────▼────┐
         │safety.ts│  │log-writer  │  │heartbeat│
         └─────────┘  └───────────┘  └─────────┘
              │
              │ selects
              ▼
    ┌──────────────────┐
    │ adapter-factory   │
    └────────┬─────────┘
             │
    ┌────────┼────────┬───────────┐
    │        │        │           │
┌───▼───┐┌──▼──┐┌────▼───┐┌─────▼────┐
│claude ││codex││gemini  ││template  │
│adapter││adapt││adapter ││adapter   │
└───┬───┘└──┬──┘└────┬───┘└──────────┘
    │       │        │
    └───────┼────────┘
            │ all use
            ▼
    ┌──────────────┐
    │ tmux-manager  │
    └──────────────┘


    ┌─────────────────┐         ┌──────────────┐
    │ terminal/server  │◄───JWT──│terminal/auth │
    │ (port 4101)      │         └──────────────┘
    └────────┬────────┘
             │ node-pty
             ▼
        tmux attach-session
```
