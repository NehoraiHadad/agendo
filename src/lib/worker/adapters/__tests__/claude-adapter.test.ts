import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

const mockStdinWrite = vi.fn((_chunk: string) => true);
let mockProc: EventEmitter & {
  stdin: Writable & { writable: boolean };
  stdout: Readable;
  stderr: Readable;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

vi.mock('@/lib/worker/tmux-manager', () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdin: Writable & { writable: boolean };
      stdout: Readable;
      stderr: Readable;
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdin = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        mockStdinWrite(chunk.toString());
        cb();
      },
    }) as Writable & { writable: boolean };
    proc.stdin.writable = true;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.pid = 12345;
    proc.kill = vi.fn();
    Object.assign(proc, { unref: vi.fn() });
    mockProc = proc;
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

  describe('sendMessage session_id', () => {
    it('uses captured session_id from stdout init event', async () => {
      const adapter = new ClaudeAdapter();
      adapter.spawn('test prompt', opts);

      // Simulate Claude emitting the init message on stdout
      mockProc.stdout.push(
        Buffer.from('{"type":"system","subtype":"init","session_id":"real-session-id"}\n'),
      );

      // Wait for nextTick-based stream resume to flush buffered data to the handler
      await new Promise((resolve) => setImmediate(resolve));

      await adapter.sendMessage('follow-up');

      // Find the sendMessage write (after the initial spawn write)
      const allWrites = mockStdinWrite.mock.calls.map((c) => JSON.parse(c[0]));
      const msgWrite = allWrites.find(
        (w: Record<string, unknown>) => w.type === 'user' && w.session_id === 'real-session-id',
      );
      expect(msgWrite).toBeDefined();
      expect(msgWrite.session_id).toBe('real-session-id');
    });

    it('falls back to "default" session_id before init event received', async () => {
      const adapter = new ClaudeAdapter();
      adapter.spawn('test prompt', opts);

      // No stdout init event — sessionId is still null
      await adapter.sendMessage('early message');

      const allWrites = mockStdinWrite.mock.calls.map((c) => JSON.parse(c[0]));
      const msgWrite = allWrites.find(
        (w: Record<string, unknown>) => w.type === 'user' && w.message?.content === 'early message',
      );
      expect(msgWrite).toBeDefined();
      expect(msgWrite.session_id).toBe('default');
    });
  });
});
