import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '@/lib/logger';

const log = createLogger('acp-terminal-handler');

/** Internal state for a managed terminal. */
interface TerminalEntry {
  process: ChildProcess;
  output: string;
  maxOutputBytes: number;
  exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  released: boolean;
}

let terminalCounter = 0;

/**
 * Handles ACP terminal/* protocol methods.
 *
 * When an ACP agent (Gemini, Copilot) requests terminal creation,
 * this handler spawns a child process, captures its output, and
 * provides kill/release/waitForExit operations.
 *
 * Used by GeminiClientHandler and CopilotClientHandler to implement
 * the optional `createTerminal`, `terminalOutput`, `killTerminal`,
 * `releaseTerminal`, and `waitForTerminalExit` Client methods.
 */
export class AcpTerminalHandler {
  private terminals = new Map<string, TerminalEntry>();

  /**
   * Create a new terminal and execute a command.
   * Returns a unique terminalId for subsequent operations.
   */
  async createTerminal(params: {
    command: string;
    args?: string[];
    cwd?: string | null;
    env?: Array<{ name: string; value: string }>;
    maxOutputBytes?: number;
  }): Promise<{ terminalId: string }> {
    const terminalId = `acp-term-${++terminalCounter}-${Date.now()}`;
    const maxOutputBytes = params.maxOutputBytes ?? 1024 * 1024; // 1MB default

    const envOverrides: NodeJS.ProcessEnv = { ...process.env };
    if (params.env) {
      for (const { name, value } of params.env) {
        envOverrides[name] = value;
      }
    }

    const cp: ChildProcess = nodeSpawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      env: envOverrides,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';

    const appendOutput = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output += text;
      // Truncate from the beginning if we exceed maxOutputBytes
      if (Buffer.byteLength(output, 'utf-8') > maxOutputBytes) {
        const buf = Buffer.from(output, 'utf-8');
        output = buf.subarray(buf.length - maxOutputBytes).toString('utf-8');
      }
    };

    if (cp.stdout) cp.stdout.on('data', appendOutput);
    if (cp.stderr) cp.stderr.on('data', appendOutput);

    // Use 'close' event instead of 'exit' — 'close' fires after all stdio streams are flushed,
    // guaranteeing that output is fully captured before we resolve.
    const exitPromise = new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve) => {
        cp.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          const status = { exitCode: code, signal: signal as string | null };
          const entry = this.terminals.get(terminalId);
          if (entry) {
            entry.exitStatus = status;
            entry.output = output;
          }
          resolve(status);
        });
        // Also handle error (e.g. command not found)
        cp.on('error', () => {
          const status = { exitCode: -1, signal: null };
          const entry = this.terminals.get(terminalId);
          if (entry) {
            entry.exitStatus = status;
            entry.output = output;
          }
          resolve(status);
        });
      },
    );

    const entry: TerminalEntry = {
      process: cp,
      output: '',
      maxOutputBytes,
      exitPromise,
      exitStatus: null,
      released: false,
    };

    // Keep output reference live via closure
    Object.defineProperty(entry, 'output', {
      get: () => output,
      set: (v: string) => {
        output = v;
      },
    });

    this.terminals.set(terminalId, entry);

    log.info({ terminalId, command: params.command, args: params.args }, 'terminal created');

    return { terminalId };
  }

  /**
   * Get the current output of a terminal.
   * Throws if terminal has been released.
   */
  terminalOutput(terminalId: string): string {
    const entry = this.getEntry(terminalId);
    return entry.output;
  }

  /**
   * Get the current output and exit status (ACP-compatible response shape).
   */
  getTerminalOutputResponse(terminalId: string): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
  } {
    const entry = this.getEntry(terminalId);
    const truncated = Buffer.byteLength(entry.output, 'utf-8') >= entry.maxOutputBytes;
    return {
      output: entry.output,
      truncated,
      ...(entry.exitStatus ? { exitStatus: entry.exitStatus } : {}),
    };
  }

  /**
   * Wait for a terminal command to exit.
   * Returns the exit status.
   */
  async waitForTerminalExit(
    terminalId: string,
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const entry = this.getEntry(terminalId);
    if (entry.exitStatus) return entry.exitStatus;
    return entry.exitPromise;
  }

  /**
   * Kill a terminal command without releasing the terminal.
   * The terminal ID remains valid for output retrieval.
   */
  killTerminal(terminalId: string): void {
    const entry = this.getEntry(terminalId);
    if (!entry.exitStatus) {
      try {
        entry.process.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
    log.info({ terminalId }, 'terminal killed');
  }

  /**
   * Release a terminal and free all associated resources.
   * Kills the process if still running and removes the entry.
   */
  releaseTerminal(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) {
      log.warn({ terminalId }, 'releaseTerminal called on unknown terminal');
      return;
    }

    entry.released = true;
    if (!entry.exitStatus) {
      try {
        entry.process.kill('SIGKILL');
      } catch {
        // Process may have already exited
      }
    }

    this.terminals.delete(terminalId);
    log.info({ terminalId }, 'terminal released');
  }

  /**
   * Clean up all terminals (called on session end / worker shutdown).
   */
  releaseAll(): void {
    for (const [id] of this.terminals) {
      this.releaseTerminal(id);
    }
  }

  /** Get a terminal entry or throw if not found / released. */
  private getEntry(terminalId: string): TerminalEntry {
    const entry = this.terminals.get(terminalId);
    if (!entry || entry.released) {
      throw new Error(`Terminal not found or already released: ${terminalId}`);
    }
    return entry;
  }
}
