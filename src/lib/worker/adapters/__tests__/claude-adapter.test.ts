import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

vi.mock('@/lib/worker/tmux-manager', () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter();
    (proc as EventEmitter & { stdin: Writable }).stdin = new Writable({
      write: vi.fn((_c: Buffer, _e: string, cb: () => void) => cb()),
    });
    (proc as EventEmitter & { stdout: Readable }).stdout = new Readable({ read() {} });
    (proc as EventEmitter & { stderr: Readable }).stderr = new Readable({ read() {} });
    (proc as EventEmitter & { pid: number }).pid = 12345;
    (proc as EventEmitter & { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();
    return proc;
  }),
}));

import { ClaudeAdapter } from '@/lib/worker/adapters/claude-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
};

describe('ClaudeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractSessionId', () => {
    it('extracts session_id from system init message', () => {
      const adapter = new ClaudeAdapter();
      const output = '{"type":"system","subtype":"init","session_id":"abc-123"}\n';
      expect(adapter.extractSessionId(output)).toBe('abc-123');
    });

    it('returns null for non-init messages', () => {
      const adapter = new ClaudeAdapter();
      expect(adapter.extractSessionId('{"type":"assistant","text":"hello"}')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const adapter = new ClaudeAdapter();
      expect(adapter.extractSessionId('not json')).toBeNull();
    });
  });

  describe('spawn', () => {
    it('returns managed process with correct tmux session name', () => {
      const adapter = new ClaudeAdapter();
      const proc = adapter.spawn('test prompt', opts);
      expect(proc.tmuxSession).toBe('claude-test-exec');
      expect(proc.pid).toBe(12345);
    });
  });
});
