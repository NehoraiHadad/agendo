import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import type {
  AgentAdapter,
  ToolApprovalFn,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';

export class TemplateAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private tmuxSessionName = '';

  spawn(commandStr: string, opts: SpawnOpts): ManagedProcess {
    this.tmuxSessionName = `exec-${opts.executionId}`;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    const tokens = commandStr.split(' ');
    const binary = tokens[0];
    const args = [...tokens.slice(1), ...(opts.extraArgs ?? [])];

    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    this.childProcess = nodeSpawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const cp = this.childProcess;

    cp.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    cp.on('exit', (code) => {
      tmux.killSession(this.tmuxSessionName);
      for (const cb of exitCallbacks) cb(code);
    });

    return {
      pid: cp.pid ?? 0,
      tmuxSession: this.tmuxSessionName,
      stdin: null,
      kill: (signal) => this.childProcess?.kill(signal),
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  resume(_sessionRef: string, _prompt: string, _opts: SpawnOpts): ManagedProcess {
    throw new Error('Template adapter does not support session resume');
  }

  extractSessionId(_output: string): string | null {
    return null;
  }

  async sendMessage(_message: string): Promise<void> {
    throw new Error('Template adapter does not support sending messages');
  }

  async interrupt(): Promise<void> {
    this.childProcess?.kill('SIGINT');
  }

  isAlive(): boolean {
    return false;
  }

  // Template adapter runs non-interactive commands; thinking and approval
  // callbacks are no-ops since there is no interactive protocol.
  onThinkingChange(_cb: (thinking: boolean) => void): void {
    /* no-op */
  }
  setApprovalHandler(_handler: ToolApprovalFn): void {
    /* no-op */
  }
}
