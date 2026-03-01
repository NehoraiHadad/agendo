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
  executionId: 'test-exec-1',
  timeoutSec: 60,
  maxOutputBytes: 1024,
  persistentSession: true,
};

describe('ClaudeAdapter line buffering', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    adapter = new ClaudeAdapter();
    mockStdinWrite.mockClear();
  });

  it('handles result JSON split across two chunks', async () => {
    const thinkingStates: boolean[] = [];
    adapter.onThinkingChange((thinking) => thinkingStates.push(thinking));
    adapter.spawn('test prompt', opts);

    // Simulate a result line split across two chunks
    const resultJson = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.05,
      num_turns: 3,
      duration_ms: 1500,
    });
    const splitPoint = Math.floor(resultJson.length / 2);
    const chunk1 = resultJson.slice(0, splitPoint);
    const chunk2 = resultJson.slice(splitPoint) + '\n';

    // First chunk: incomplete JSON, should NOT trigger thinking=false
    mockProc.stdout.push(Buffer.from(chunk1));
    // Wait for event processing
    await new Promise((r) => setTimeout(r, 10));

    // thinking=true should have been emitted (first data byte)
    expect(thinkingStates).toContain(true);
    // But thinking=false should NOT have fired yet (no complete line)
    const falseCountBefore = thinkingStates.filter((s) => s === false).length;
    expect(falseCountBefore).toBe(0);

    // Second chunk: completes the line — should now trigger thinking=false
    mockProc.stdout.push(Buffer.from(chunk2));
    await new Promise((r) => setTimeout(r, 10));

    const falseCountAfter = thinkingStates.filter((s) => s === false).length;
    expect(falseCountAfter).toBe(1);
  });

  it('handles control_request split across chunks', async () => {
    adapter.spawn('test prompt', opts);
    const approvalHandler = vi.fn(async () => 'allow' as const);
    adapter.setApprovalHandler(approvalHandler);

    // Simulate a control_request split across two chunks
    const controlJson = JSON.stringify({
      type: 'control_request',
      request_id: 'test-req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
      },
    });
    const splitPoint = 30; // split early to test carryover
    const chunk1 = controlJson.slice(0, splitPoint);
    const chunk2 = controlJson.slice(splitPoint) + '\n';

    mockProc.stdout.push(Buffer.from(chunk1));
    await new Promise((r) => setTimeout(r, 10));

    // Approval handler should NOT have been called yet
    expect(approvalHandler).not.toHaveBeenCalled();

    mockProc.stdout.push(Buffer.from(chunk2));
    await new Promise((r) => setTimeout(r, 50));

    // Now the handler should have been called with the complete control_request
    expect(approvalHandler).toHaveBeenCalledTimes(1);
    expect(approvalHandler).toHaveBeenCalledWith({
      approvalId: 'test-req-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
  });

  it('handles multiple complete lines in one chunk', async () => {
    const thinkingStates: boolean[] = [];
    adapter.onThinkingChange((thinking) => thinkingStates.push(thinking));
    adapter.spawn('test prompt', opts);

    const initJson = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'test-session-123',
      slash_commands: ['/help'],
      mcp_servers: [],
    });
    const resultJson = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 500,
    });

    // Both lines in one chunk
    mockProc.stdout.push(Buffer.from(initJson + '\n' + resultJson + '\n'));
    await new Promise((r) => setTimeout(r, 10));

    // Should have extracted session ID
    expect(adapter.extractSessionId(initJson)).toBe('test-session-123');

    // Should have triggered thinking=false for the result
    expect(thinkingStates).toContain(false);
  });

  it('forwards raw text to data callbacks unchanged', async () => {
    adapter.spawn('test prompt', opts);
    const receivedChunks: string[] = [];
    // Access managedProcess via the returned object
    const managed = adapter.spawn('test prompt 2', {
      ...opts,
      executionId: 'test-exec-2',
    });
    managed.onData((chunk) => receivedChunks.push(chunk));

    const rawText = '{"type":"assistant","message":{"content":[]}}\npartial';
    mockProc.stdout.push(Buffer.from(rawText));
    await new Promise((r) => setTimeout(r, 10));

    // Raw text should be forwarded as-is (no buffering transformation)
    expect(receivedChunks.join('')).toBe(rawText);
  });
});
