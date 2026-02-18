import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';

export class ClaudeAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private tmuxSessionName = '';
  private sessionId: string | null = null;

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, []);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, ['--resume', sessionRef]);
  }

  extractSessionId(output: string): string | null {
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          return parsed.session_id;
        }
      } catch {
        // Not valid JSON
      }
    }
    return null;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.childProcess?.stdin?.writable) {
      throw new Error('Claude process stdin is not writable');
    }
    const ndjsonMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
      session_id: this.sessionId ?? 'default',
      parent_tool_use_id: null,
    });
    this.childProcess.stdin.write(ndjsonMessage + '\n');
  }

  interrupt(): void {
    this.childProcess?.kill('SIGINT');
  }

  private launch(prompt: string, opts: SpawnOpts, extraFlags: string[]): ManagedProcess {
    this.tmuxSessionName = `claude-${opts.executionId}`;
    this.sessionId = null;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

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
      ...(opts.extraArgs ?? []),
    ];

    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    this.childProcess = nodeSpawn('claude', claudeArgs, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });

    const cp = this.childProcess;
    cp.unref();

    const initialMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: 'default',
      parent_tool_use_id: null,
    });
    cp.stdin?.write(initialMessage + '\n');

    cp.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      if (!this.sessionId) {
        this.sessionId = this.extractSessionId(text);
      }
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
      kill: (signal) => {
        const p = this.childProcess;
        if (!p?.pid) return;
        try {
          process.kill(-p.pid, signal);
        } catch {
          // Process group already dead
        }
      },
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }
}
