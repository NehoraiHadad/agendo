import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

interface MockChildProcess extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: () => void;
  kill: (signal?: string) => void;
}

let mockChildProc: MockChildProcess;

function createMockChildProc(): MockChildProcess {
  const cp = new EventEmitter() as MockChildProcess;
  cp.pid = 12345;
  cp.stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.unref = vi.fn();
  cp.kill = vi.fn();
  return cp;
}

// Typed mock so mock.calls[n] gives proper types
const mockSpawn =
  vi.fn<(bin: string, args: string[], opts: Record<string, unknown>) => MockChildProcess>();

vi.mock('node:child_process', () => ({
  spawn: (bin: string, args: string[], opts: Record<string, unknown>) => mockSpawn(bin, args, opts),
}));

vi.mock('@/lib/worker/tmux-manager', () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
}));

import { CodexAdapter } from '@/lib/worker/adapters/codex-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const baseOpts: SpawnOpts = {
  cwd: '/home/ubuntu/projects/test',
  env: { PATH: '/usr/bin', HOME: '/home/ubuntu' },
  executionId: 'test-exec-001',
  timeoutSec: 300,
  maxOutputBytes: 1024 * 1024,
};

describe('CodexAdapter (STDIO)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChildProc = createMockChildProc();
    mockSpawn.mockReturnValue(mockChildProc);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to get spawn call args
  function getSpawnCall(index = 0) {
    const call = mockSpawn.mock.calls[index];
    return { binary: call[0], args: call[1], options: call[2] };
  }

  // -----------------------------------------------------------------------
  // spawn()
  // -----------------------------------------------------------------------
  describe('spawn()', () => {
    it('spawns codex exec with --json flag and correct cwd', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('Write hello world', baseOpts);

      expect(mockSpawn).toHaveBeenCalledOnce();
      const { binary, args, options } = getSpawnCall();
      expect(binary).toBe('codex');
      expect(args).toContain('exec');
      expect(args).toContain('--json');
      expect(args).toContain('--cd');
      expect(args).toContain('/home/ubuntu/projects/test');
      expect(args).toContain('Write hello world');
      expect(options.cwd).toBe('/home/ubuntu/projects/test');
      expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    });

    it('returns a ManagedProcess with the child pid', () => {
      const adapter = new CodexAdapter();
      const proc = adapter.spawn('test', baseOpts);
      expect(proc.pid).toBe(12345);
    });

    it('returns ManagedProcess with null stdin (codex does not accept stdin)', () => {
      const adapter = new CodexAdapter();
      const proc = adapter.spawn('test', baseOpts);
      expect(proc.stdin).toBeNull();
    });

    it('fires data callbacks on stdout data', () => {
      const adapter = new CodexAdapter();
      const proc = adapter.spawn('test', baseOpts);
      const chunks: string[] = [];
      proc.onData((chunk) => chunks.push(chunk));

      mockChildProc.stdout.emit('data', Buffer.from('{"type":"turn.started"}\n'));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('{"type":"turn.started"}\n');
    });

    it('fires exit callbacks when process exits', () => {
      const adapter = new CodexAdapter();
      const proc = adapter.spawn('test', baseOpts);
      const codes: (number | null)[] = [];
      proc.onExit((code) => codes.push(code));

      mockChildProc.emit('exit', 0);
      expect(codes).toEqual([0]);
    });
  });

  // -----------------------------------------------------------------------
  // Permission mode mapping
  // -----------------------------------------------------------------------
  describe('permission mode flags', () => {
    it('uses --dangerously-bypass-approvals-and-sandbox for bypassPermissions', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', { ...baseOpts, permissionMode: 'bypassPermissions' });

      const { args } = getSpawnCall();
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('uses --dangerously-bypass-approvals-and-sandbox for dontAsk', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', { ...baseOpts, permissionMode: 'dontAsk' });

      const { args } = getSpawnCall();
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('uses --sandbox workspace-write for acceptEdits', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', { ...baseOpts, permissionMode: 'acceptEdits' });

      const { args } = getSpawnCall();
      expect(args).toContain('--sandbox');
      expect(args).toContain('workspace-write');
    });

    it('uses --sandbox workspace-write for default mode', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', { ...baseOpts, permissionMode: 'default' });

      const { args } = getSpawnCall();
      expect(args).toContain('--sandbox');
      expect(args).toContain('workspace-write');
    });

    it('uses --sandbox read-only for plan mode', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', { ...baseOpts, permissionMode: 'plan' });

      const { args } = getSpawnCall();
      expect(args).toContain('--sandbox');
      expect(args).toContain('read-only');
    });
  });

  // -----------------------------------------------------------------------
  // resume()
  // -----------------------------------------------------------------------
  describe('resume()', () => {
    it('spawns codex exec resume with thread_id', () => {
      const adapter = new CodexAdapter();
      adapter.resume('thread_abc', 'Continue working', baseOpts);

      expect(mockSpawn).toHaveBeenCalledOnce();
      const { args } = getSpawnCall();
      expect(args).toContain('exec');
      expect(args).toContain('resume');
      expect(args).toContain('thread_abc');
      expect(args).toContain('Continue working');
      expect(args).toContain('--json');
    });
  });

  // -----------------------------------------------------------------------
  // sendMessage() — virtual process replacement
  // -----------------------------------------------------------------------
  describe('sendMessage()', () => {
    it('kills old process and spawns a new resume process', async () => {
      const adapter = new CodexAdapter();
      const proc = adapter.spawn('initial prompt', baseOpts);

      // Register callbacks on the virtual ManagedProcess
      const allData: string[] = [];
      const allExits: (number | null)[] = [];
      proc.onData((chunk) => allData.push(chunk));
      proc.onExit((code) => allExits.push(code));

      // Simulate thread.started so we get a threadId
      mockChildProc.stdout.emit(
        'data',
        Buffer.from('{"type":"thread.started","thread_id":"thread_xyz"}\n'),
      );
      // Simulate turn completion + exit (normal end of first exec)
      mockChildProc.stdout.emit(
        'data',
        Buffer.from('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}\n'),
      );
      mockChildProc.emit('exit', 0);

      // Create a fresh mock for the second spawn
      const secondProc = createMockChildProc();
      secondProc.pid = 22222;
      mockSpawn.mockReturnValue(secondProc);

      // sendMessage should spawn a new resume process
      await adapter.sendMessage('Follow up message');

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const { args: resumeArgs } = getSpawnCall(1);
      expect(resumeArgs).toContain('resume');
      expect(resumeArgs).toContain('thread_xyz');
      expect(resumeArgs).toContain('Follow up message');

      // Callbacks from the new process should reach the original virtual ManagedProcess
      secondProc.stdout.emit('data', Buffer.from('{"type":"turn.started"}\n'));
      expect(allData).toContain('{"type":"turn.started"}\n');
    });

    it('throws if no thread ID is established', async () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', baseOpts);

      // Process exits without thread.started
      mockChildProc.emit('exit', 0);

      await expect(adapter.sendMessage('hello')).rejects.toThrow(/No Codex thread ID/);
    });
  });

  // -----------------------------------------------------------------------
  // extractSessionId
  // -----------------------------------------------------------------------
  describe('extractSessionId', () => {
    it('returns thread_id after thread.started event', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', baseOpts);

      mockChildProc.stdout.emit(
        'data',
        Buffer.from('{"type":"thread.started","thread_id":"thread_123"}\n'),
      );

      expect(adapter.extractSessionId('')).toBe('thread_123');
    });

    it('returns null before thread.started', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', baseOpts);

      expect(adapter.extractSessionId('')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // interrupt()
  // -----------------------------------------------------------------------
  describe('interrupt()', () => {
    it('kills the current process with SIGTERM', async () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', baseOpts);

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      // Start interrupt — it sends SIGTERM then waits
      const interruptPromise = adapter.interrupt();

      // Simulate process exit after SIGTERM
      mockChildProc.emit('exit', null);

      await interruptPromise;

      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      killSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // isAlive()
  // -----------------------------------------------------------------------
  describe('isAlive()', () => {
    it('returns true when a process is running', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', baseOpts);
      expect(adapter.isAlive()).toBe(true);
    });

    it('returns false after process exits', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', baseOpts);
      mockChildProc.emit('exit', 0);
      expect(adapter.isAlive()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Thinking callbacks
  // -----------------------------------------------------------------------
  describe('thinking callbacks', () => {
    it('fires thinking(true) on turn.started, thinking(false) on turn.completed', () => {
      const adapter = new CodexAdapter();
      const states: boolean[] = [];
      adapter.onThinkingChange((t) => states.push(t));
      adapter.spawn('test', baseOpts);

      mockChildProc.stdout.emit('data', Buffer.from('{"type":"turn.started"}\n'));
      mockChildProc.stdout.emit('data', Buffer.from('{"type":"turn.completed"}\n'));

      expect(states).toEqual([true, false]);
    });
  });

  // -----------------------------------------------------------------------
  // mapJsonToEvents (delegates to event mapper)
  // -----------------------------------------------------------------------
  describe('mapJsonToEvents()', () => {
    it('maps Codex JSONL to AgendoEventPayloads', () => {
      const adapter = new CodexAdapter();
      const events = adapter.mapJsonToEvents({
        type: 'thread.started',
        thread_id: 'thread_999',
      });
      expect(events).toEqual([
        {
          type: 'session:init',
          sessionRef: 'thread_999',
          slashCommands: [],
          mcpServers: [],
        },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // sessionRef callback
  // -----------------------------------------------------------------------
  describe('onSessionRef()', () => {
    it('fires when thread.started is received', () => {
      const adapter = new CodexAdapter();
      const refs: string[] = [];
      adapter.onSessionRef((ref) => refs.push(ref));
      adapter.spawn('test', baseOpts);

      mockChildProc.stdout.emit(
        'data',
        Buffer.from('{"type":"thread.started","thread_id":"thread_ref_abc"}\n'),
      );

      expect(refs).toEqual(['thread_ref_abc']);
    });

    it('does not fire twice for the same thread', () => {
      const adapter = new CodexAdapter();
      const refs: string[] = [];
      adapter.onSessionRef((ref) => refs.push(ref));
      adapter.spawn('test', baseOpts);

      mockChildProc.stdout.emit(
        'data',
        Buffer.from('{"type":"thread.started","thread_id":"thread_once"}\n'),
      );
      mockChildProc.stdout.emit(
        'data',
        Buffer.from('{"type":"thread.started","thread_id":"thread_once"}\n'),
      );

      expect(refs).toEqual(['thread_once']);
    });
  });

  // -----------------------------------------------------------------------
  // extraArgs passthrough
  // -----------------------------------------------------------------------
  describe('extraArgs', () => {
    it('passes extra args to codex exec', () => {
      const adapter = new CodexAdapter();
      adapter.spawn('test', { ...baseOpts, extraArgs: ['--model', 'o3'] });

      const { args } = getSpawnCall();
      expect(args).toContain('--model');
      expect(args).toContain('o3');
    });
  });
});
