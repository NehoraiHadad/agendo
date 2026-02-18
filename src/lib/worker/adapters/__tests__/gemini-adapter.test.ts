import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

const mockStdinWrite = vi.fn((_data: string) => true);
let mockReadlineEmitter: EventEmitter;

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
    proc.pid = 99999;
    proc.kill = vi.fn();
    Object.assign(proc, { unref: vi.fn() });
    return proc;
  }),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => {
    mockReadlineEmitter = new EventEmitter();
    return mockReadlineEmitter;
  }),
}));

import { spawn as nodeSpawn } from 'node:child_process';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
};

describe('GeminiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns gemini with --experimental-acp flag', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);
    expect(nodeSpawn).toHaveBeenCalledWith(
      'gemini',
      expect.arrayContaining(['--experimental-acp']),
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('returns managed process with empty tmuxSession', () => {
    const adapter = new GeminiAdapter();
    const proc = adapter.spawn('test prompt', opts);
    expect(proc.tmuxSession).toBe('');
    expect(proc.pid).toBe(99999);
  });

  it('sends initialize request synchronously on spawn', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);

    // The async initAndRun runs synchronously up to the first sendRequest,
    // which calls writeJson synchronously before awaiting the response.
    expect(mockStdinWrite).toHaveBeenCalled();
    const firstWrite = JSON.parse(mockStdinWrite.mock.calls[0][0]) as Record<string, unknown>;
    expect(firstWrite.method).toBe('initialize');
    expect(firstWrite.jsonrpc).toBe('2.0');
  });

  it('extractSessionId returns null before init completes', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);
    expect(adapter.extractSessionId('')).toBeNull();
  });

  it('uses stored sessionId from resume', () => {
    const adapter = new GeminiAdapter();
    adapter.resume('session-xyz', 'continue', opts);
    expect(adapter.extractSessionId('')).toBe('session-xyz');
  });

  it('handles session/update notifications and calls onData callbacks', () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    // Simulate the server sending a session/update notification
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        messages: [{ role: 'assistant', content: 'Hello from Gemini!' }],
      },
    });
    mockReadlineEmitter.emit('line', notification);

    expect(received).toContain('Hello from Gemini!');
  });

  it('auto-approves session/request_permission server requests', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);

    // Simulate a server-initiated permission request
    const serverRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 'srv-req-1',
      method: 'session/request_permission',
      params: { action: 'run_command', command: 'ls' },
    });
    mockReadlineEmitter.emit('line', serverRequest);

    // Adapter should have written a response back
    const writes = mockStdinWrite.mock.calls.map((c) => JSON.parse(c[0]) as Record<string, unknown>);
    const response = writes.find(
      (w) => w.id === 'srv-req-1' && w.result !== undefined,
    );
    expect(response).toBeDefined();
    expect((response!.result as Record<string, unknown>).outcome).toBe('selected');
  });

  it('ignores non-JSON stdout lines', () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    // Emit non-JSON debug line — should not throw or add to received
    expect(() => mockReadlineEmitter.emit('line', 'Loading... (debug)')).not.toThrow();
    expect(received).toHaveLength(0);
  });
});
