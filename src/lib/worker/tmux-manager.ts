import { execFileSync } from 'node:child_process';

const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;

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

export function sendInput(name: string, text: string): void {
  execFileSync('tmux', ['send-keys', '-t', name, '-l', text], { stdio: 'ignore' });
}

export function pressEnter(name: string): void {
  execFileSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' });
}

export function capturePane(name: string, historyLines = 1000): string {
  return execFileSync('tmux', ['capture-pane', '-t', name, '-p', '-S', `-${historyLines}`], {
    encoding: 'utf-8',
  });
}

export function pipePaneToFile(name: string, logFilePath: string): void {
  execFileSync('tmux', ['pipe-pane', '-t', name, '-o', `cat >> ${logFilePath}`], {
    stdio: 'ignore',
  });
}

export function hasSession(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function killSession(name: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  } catch {
    // Session may already be dead
  }
}

export function resizeSession(name: string, cols: number, rows: number): void {
  execFileSync('tmux', ['resize-window', '-t', name, '-x', String(cols), '-y', String(rows)], {
    stdio: 'ignore',
  });
}

export function listSessions(): string[] {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function sendCommand(name: string, command: string): void {
  sendInput(name, command);
  pressEnter(name);
}
