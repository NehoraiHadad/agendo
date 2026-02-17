import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

const mockStdinWrite = vi.fn((_c: string) => true);

vi.mock('@/lib/worker/tmux-manager', () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter();
    (proc as EventEmitter & { stdin: Writable }).stdin = new Writable({
      write(chunk: Buffer, _encoding: string, cb: () => void) {
        mockStdinWrite(chunk.toString());
        cb();
      },
    });
    (proc as EventEmitter & { stdin: Writable & { writable: boolean } }).stdin.writable = true;
    (proc as EventEmitter & { stdout: Readable }).stdout = new Readable({ read() {} });
    (proc as EventEmitter & { stderr: Readable }).stderr = new Readable({ read() {} });
    (proc as EventEmitter & { pid: number }).pid = 54321;
    (proc as EventEmitter & { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();
    return proc;
  }),
}));

import { CodexAdapter } from '@/lib/worker/adapters/codex-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
};

describe('CodexAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends initialize handshake on spawn', () => {
    const adapter = new CodexAdapter();
    adapter.spawn('test prompt', opts);

    // First message should be initialize request
    const firstCall = mockStdinWrite.mock.calls[0][0];
    const parsed = JSON.parse(firstCall);
    expect(parsed.method).toBe('initialize');
    expect(parsed.jsonrpc).toBe('2.0');
  });

  it('sends initialized notification after initialize', () => {
    const adapter = new CodexAdapter();
    adapter.spawn('test prompt', opts);

    const secondCall = mockStdinWrite.mock.calls[1][0];
    const parsed = JSON.parse(secondCall);
    expect(parsed.method).toBe('initialized');
  });

  it('returns managed process with correct tmux session name', () => {
    const adapter = new CodexAdapter();
    const proc = adapter.spawn('test prompt', opts);
    expect(proc.tmuxSession).toBe('codex-test-exec');
    expect(proc.pid).toBe(54321);
  });
});
