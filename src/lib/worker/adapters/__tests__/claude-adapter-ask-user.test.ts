/**
 * Tests for AskUserQuestion protocol handling in ClaudeAdapter.
 *
 * AskUserQuestion arrives as a control_request with subtype === 'can_use_tool'
 * and tool_name === 'AskUserQuestion'. The adapter must:
 *  1. Pass the full input to the approval handler.
 *  2. When the handler returns { behavior: 'allow', updatedInput }, write a
 *     control_response with updatedInput.
 *  3. When the handler returns 'allow' / 'deny', use the standard response path.
 *  4. Regular tool approvals (non-AskUserQuestion) still work unchanged.
 */
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
import type { SpawnOpts, ApprovalRequest, PermissionDecision } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
  persistentSession: true,
};

/** Wait for all queued microtasks and I/O callbacks to flush. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ClaudeAdapter — AskUserQuestion protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects AskUserQuestion and passes full ApprovalRequest to handler', async () => {
    const adapter = new ClaudeAdapter();
    adapter.spawn('prompt', opts);

    const handlerCalls: ApprovalRequest[] = [];
    adapter.setApprovalHandler(async (req) => {
      handlerCalls.push(req);
      return 'allow';
    });

    const questions = [
      {
        question: 'How should I format?',
        header: 'Format',
        options: [{ label: 'Summary', description: 'Brief' }],
        multiSelect: false,
      },
    ];

    const controlRequest = JSON.stringify({
      request_id: 'req-123',
      type: 'control_request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions },
      },
    });

    mockProc.stdout.push(Buffer.from(controlRequest + '\n'));
    await flush();

    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0].toolName).toBe('AskUserQuestion');
    expect(handlerCalls[0].isAskUser).toBe(true);
    expect(handlerCalls[0].toolInput).toEqual({ questions });
  });

  it('sends control_response with updatedInput when handler returns { behavior: allow, updatedInput }', async () => {
    const adapter = new ClaudeAdapter();
    adapter.spawn('prompt', opts);

    const questions = [
      {
        question: 'Preferred style?',
        header: 'Style',
        options: [
          { label: 'Concise', description: 'Short' },
          { label: 'Verbose', description: 'Long' },
        ],
        multiSelect: false,
      },
    ];

    const updatedInput = {
      questions,
      answers: { 'Preferred style?': 'Concise' },
    };

    adapter.setApprovalHandler(async (_req): Promise<PermissionDecision> => {
      return { behavior: 'allow', updatedInput };
    });

    const controlRequest = JSON.stringify({
      request_id: 'req-456',
      type: 'control_request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions },
      },
    });

    mockProc.stdout.push(Buffer.from(controlRequest + '\n'));
    await flush();

    // Allow the async handleToolApprovalRequest to settle
    await flush();

    const writes = mockStdinWrite.mock.calls.map((c) => {
      try {
        return JSON.parse(c[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    });

    const response = writes.find(
      (w) => w !== null && w.type === 'control_response' && w.request_id === 'req-456',
    );

    expect(response).toBeDefined();
    expect(response!.request_id).toBe('req-456');
    const resp = response!.response as Record<string, unknown>;
    expect(resp.subtype).toBe('allow');
    expect(resp.updatedInput).toEqual(updatedInput);
  });

  it('sends standard allow response for regular (non-AskUserQuestion) tool approvals', async () => {
    const adapter = new ClaudeAdapter();
    adapter.spawn('prompt', opts);

    adapter.setApprovalHandler(async (req): Promise<PermissionDecision> => {
      expect(req.isAskUser).toBe(false);
      return 'allow';
    });

    const controlRequest = JSON.stringify({
      request_id: 'req-bash',
      type: 'control_request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
      },
    });

    mockProc.stdout.push(Buffer.from(controlRequest + '\n'));
    await flush();
    await flush();

    const writes = mockStdinWrite.mock.calls.map((c) => {
      try {
        return JSON.parse(c[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    });

    const response = writes.find(
      (w) => w !== null && w.type === 'control_response' && w.request_id === 'req-bash',
    );
    expect(response).toBeDefined();
    const resp = response!.response as Record<string, unknown>;
    expect(resp.subtype).toBe('allow');
    expect(resp.updatedInput).toBeUndefined();
  });

  it('sends deny response when handler returns deny', async () => {
    const adapter = new ClaudeAdapter();
    adapter.spawn('prompt', opts);

    adapter.setApprovalHandler(async (_req): Promise<PermissionDecision> => 'deny');

    const controlRequest = JSON.stringify({
      request_id: 'req-deny',
      type: 'control_request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        input: { path: '/etc/passwd' },
      },
    });

    mockProc.stdout.push(Buffer.from(controlRequest + '\n'));
    await flush();
    await flush();

    const writes = mockStdinWrite.mock.calls.map((c) => {
      try {
        return JSON.parse(c[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    });

    const response = writes.find(
      (w) => w !== null && w.type === 'control_response' && w.request_id === 'req-deny',
    );
    expect(response).toBeDefined();
    const resp = response!.response as Record<string, unknown>;
    expect(resp.subtype).toBe('deny');
  });

  it('passes approvalId and toolName in ApprovalRequest for regular tools', async () => {
    const adapter = new ClaudeAdapter();
    adapter.spawn('prompt', opts);

    let capturedRequest: ApprovalRequest | null = null;
    adapter.setApprovalHandler(async (req): Promise<PermissionDecision> => {
      capturedRequest = req;
      return 'allow';
    });

    const controlRequest = JSON.stringify({
      request_id: 'req-tool',
      type: 'control_request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        input: { path: '/tmp/test.txt' },
      },
    });

    mockProc.stdout.push(Buffer.from(controlRequest + '\n'));
    await flush();
    await flush();

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.approvalId).toBe('req-tool');
    expect(capturedRequest!.toolName).toBe('Read');
    expect(capturedRequest!.toolInput).toEqual({ path: '/tmp/test.txt' });
    expect(capturedRequest!.isAskUser).toBe(false);
  });
});

describe('ClaudeAdapter — CompactBoundaryMessage handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw or crash when receiving a compact boundary message', async () => {
    // The compact message type is a signal from Claude that it has compacted context.
    // The session-process.ts maps it to a system:info event — the adapter just forwards
    // the raw NDJSON downstream without special handling.
    const adapter = new ClaudeAdapter();
    const dataChunks: string[] = [];
    const proc = adapter.spawn('prompt', opts);
    proc.onData((chunk) => dataChunks.push(chunk));

    const compactMsg = JSON.stringify({ type: 'compact', summary: 'Context compacted.' });
    mockProc.stdout.push(Buffer.from(compactMsg + '\n'));
    await flush();

    // The raw chunk should have been forwarded to data callbacks
    expect(dataChunks.some((c) => c.includes('"type":"compact"'))).toBe(true);
  });
});
