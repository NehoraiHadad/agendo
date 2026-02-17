import { execFileSync } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';

const POLL_INTERVAL_MS = 500;

export class GeminiAdapter implements AgentAdapter {
  private tmuxSessionName = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastCaptureLength = 0;

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, []);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, ['--resume', 'latest']);
  }

  extractSessionId(_output: string): string | null {
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
    if (tmux.hasSession(this.tmuxSessionName)) {
      tmux.sendInput(this.tmuxSessionName, '\x03');
    }
  }

  private launch(prompt: string, opts: SpawnOpts, extraFlags: string[]): ManagedProcess {
    this.tmuxSessionName = `gemini-${opts.executionId}`;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    const geminiCmd = ['gemini', ...extraFlags, '-i', prompt].join(' ');

    tmux.createSession(this.tmuxSessionName, {
      cwd: opts.cwd,
      command: geminiCmd,
    });

    const pipeFile = `/tmp/gemini-${opts.executionId}.pipe`;
    tmux.pipePaneToFile(this.tmuxSessionName, pipeFile);

    this.pollTimer = setInterval(() => {
      if (!tmux.hasSession(this.tmuxSessionName)) {
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

    let pid = 0;
    try {
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
