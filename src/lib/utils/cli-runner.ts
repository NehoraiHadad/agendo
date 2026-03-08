/**
 * Shared CLI runner utilities.
 *
 * Provides common primitives for spawning CLI subprocesses:
 * - stripBlockedEnvVars() — removes env vars that break CLIs inside Claude Code
 * - collectCliOutput()   — spawn a process and collect stdout as a string
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/**
 * Env vars that must be stripped before spawning agent CLIs.
 * These cause Claude/Gemini/Codex to fail or behave unexpectedly
 * when running inside a Claude Code session.
 */
const BLOCKED_ENV_VARS = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']);

/**
 * Return a copy of `process.env` with blocked vars removed.
 */
export function stripBlockedEnvVars(): NodeJS.ProcessEnv {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV_VARS.has(key)) {
      clean[key] = value;
    }
  }
  return clean as NodeJS.ProcessEnv;
}

export interface SpawnCliOpts {
  /** Command to run. */
  command: string;
  /** Arguments. */
  args: string[];
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Hard kill timeout in ms. Default: 120_000 (2 min). */
  timeoutMs?: number;
  /** Abort signal — SIGTERMs the process when fired. */
  signal?: AbortSignal;
}

/**
 * Spawn a CLI process with sanitized env, timeout, and abort support.
 * Returns the ChildProcess for custom handling (streaming, etc.).
 *
 * stdin is set to 'ignore' to prevent hangs in headless mode.
 */
export function spawnCli(opts: SpawnCliOpts): {
  process: ChildProcess;
  cleanup: () => void;
} {
  const { command, args, cwd, timeoutMs = 120_000, signal } = opts;

  const spawnOpts: SpawnOptions = {
    cwd: cwd ?? process.cwd(),
    env: stripBlockedEnvVars(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  };

  const cp = spawn(command, args, spawnOpts);

  const timeoutId = setTimeout(() => {
    try {
      cp.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }, timeoutMs);

  const onAbort = () => {
    try {
      cp.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  };
  signal?.addEventListener('abort', onAbort);

  const cleanup = () => {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  };

  return { process: cp, cleanup };
}

/**
 * Spawn a CLI process and collect its full stdout as a string.
 * Rejects on non-zero exit, timeout, or spawn error.
 */
export function collectCliOutput(opts: SpawnCliOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const { process: cp, cleanup } = spawnCli(opts);

    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    cp.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    cp.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    cp.on('error', (err) => {
      cleanup();
      reject(err);
    });

    cp.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').slice(0, 500);
        reject(new Error(`${opts.command} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
  });
}
