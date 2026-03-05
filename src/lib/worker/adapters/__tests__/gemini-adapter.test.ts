import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mock node:child_process — controlled process for isAlive / pid / kill tests
// ---------------------------------------------------------------------------

let mockChildProcess: EventEmitter & {
  stdin: Writable & { writable: boolean };
  stdout: Readable;
  stderr: Readable;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as typeof mockChildProcess;
    proc.stdin = new Writable({
      write(_chunk: Buffer, _enc: string, cb: () => void) {
        cb();
      },
    }) as Writable & { writable: boolean };
    proc.stdin.writable = true;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.pid = 99999;
    proc.kill = vi.fn();
    Object.assign(proc, { unref: vi.fn() });
    mockChildProcess = proc;
    return proc;
  }),
}));

// ---------------------------------------------------------------------------
// Mock @agentclientprotocol/sdk — control ACP requests/responses in tests
// ---------------------------------------------------------------------------

type AcpClientHandler = {
  sessionUpdate: (params: Record<string, unknown>) => Promise<void>;
  requestPermission: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type MockConnection = {
  initialize: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  setSessionMode: ReturnType<typeof vi.fn>;
  unstable_resumeSession: ReturnType<typeof vi.fn>;
};

let capturedClientHandler: AcpClientHandler | null = null;

let mockConnection: MockConnection = {
  initialize: vi.fn(),
  newSession: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  loadSession: vi.fn(),
  setSessionMode: vi.fn(),
  unstable_resumeSession: vi.fn(),
};

/**
 * Pre-configurable initialize response — set BEFORE calling spawn()/resume()
 * because initialize() is called synchronously within the spawn call.
 * Default: resolves with no special capabilities.
 */
let initializeImpl: () => Promise<{ agentCapabilities: Record<string, unknown> }> = () =>
  Promise.resolve({ agentCapabilities: {} });

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: '1.0.0',
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function (
    this: unknown,
    handlerFactory: (agent: null) => AcpClientHandler,
  ) {
    capturedClientHandler = handlerFactory(null);
    mockConnection = {
      initialize: vi.fn(() => initializeImpl()),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'default-session' }),
      prompt: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue(undefined),
      loadSession: vi.fn().mockResolvedValue(null),
      setSessionMode: vi.fn().mockResolvedValue(undefined),
      unstable_resumeSession: vi.fn().mockResolvedValue(undefined),
    };
    return mockConnection;
  }),
}));

import { spawn as nodeSpawn } from 'node:child_process';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import type { SpawnOpts, ImageContent } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
};

/**
 * Configure the mock connection to auto-resolve all ACP methods.
 * Must be called AFTER adapter.spawn() so mockConnection is populated.
 */
function setupAutoResponder(
  sessionId = 'test-session-123',
  promptResult: Record<string, unknown> = {},
): void {
  mockConnection.initialize.mockResolvedValue({ agentCapabilities: {} });
  mockConnection.newSession.mockResolvedValue({ sessionId });
  mockConnection.prompt.mockResolvedValue(promptResult);
  mockConnection.cancel.mockResolvedValue(undefined);
}

describe('GeminiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedClientHandler = null;
    initializeImpl = () => Promise.resolve({ agentCapabilities: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('sends initialize request with clientInfo and terminal capability', async () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);

    // initialize is called asynchronously in initAndRun
    await vi.waitFor(() => expect(mockConnection.initialize).toHaveBeenCalled());

    const [initParams] = mockConnection.initialize.mock.calls[0] as [Record<string, unknown>];
    expect(initParams.clientInfo).toEqual({ name: 'agendo', version: '1.0.0' });
    const caps = initParams.clientCapabilities as Record<string, unknown>;
    expect(caps.terminal).toBe(true);
    expect(caps.fs).toEqual({ readTextFile: true, writeTextFile: true });
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

  // ---------------------------------------------------------------------------
  // NDJSON emission: text and thinking
  // ---------------------------------------------------------------------------

  it('emits gemini:text-delta NDJSON for agent_message_chunk notifications', async () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await capturedClientHandler!.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from Gemini!' },
      },
    });

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('gemini:text-delta');
    expect(parsed.text).toBe('Hello from Gemini!');
  });

  it('emits gemini:thinking-delta NDJSON for agent_thought_chunk notifications', async () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await capturedClientHandler!.sessionUpdate({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking about it...' },
      },
    });

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('gemini:thinking-delta');
    expect(parsed.text).toBe('Thinking about it...');
  });

  // ---------------------------------------------------------------------------
  // Turn completion: emits gemini:turn-complete
  // ---------------------------------------------------------------------------

  it('emits gemini:turn-complete NDJSON after sendPrompt resolves', async () => {
    const promptResult = { sessionId: 'test-session-123', done: true };
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder('test-session-123', promptResult);
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      const turnComplete = received.find((r) => r.includes('gemini:turn-complete'));
      expect(turnComplete).toBeDefined();
    });

    const turnComplete = received.find((r) => r.includes('gemini:turn-complete'));
    const parsed = JSON.parse(turnComplete!) as Record<string, unknown>;
    expect(parsed.type).toBe('gemini:turn-complete');
    // The adapter passes through the ACP prompt() response as the result
    expect(parsed.result).toEqual(promptResult);
  });

  // ---------------------------------------------------------------------------
  // Tool approval: emits gemini:tool-start and gemini:tool-end
  // ---------------------------------------------------------------------------

  it('emits gemini:tool-start and gemini:tool-end for permission requests (auto-approve)', async () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    const permissionResult = await capturedClientHandler!.requestPermission({
      toolCall: { title: 'Bash', rawInput: { command: 'ls -la' } },
      options: [{ kind: 'allow_once', optionId: 'opt-1', name: 'Allow once' }],
    });

    const toolStart = received.find((r) => r.includes('gemini:tool-start'));
    const toolEnd = received.find((r) => r.includes('gemini:tool-end'));
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();

    const parsedStart = JSON.parse(toolStart!) as Record<string, unknown>;
    expect(parsedStart.toolName).toBe('Bash');
    expect(parsedStart.toolInput).toEqual({ command: 'ls -la' });

    const outcome = (permissionResult as Record<string, unknown>).outcome as Record<
      string,
      unknown
    >;
    expect(outcome.outcome).toBe('selected');
  });

  // ---------------------------------------------------------------------------
  // mapJsonToEvents delegation
  // ---------------------------------------------------------------------------

  it('has mapJsonToEvents that delegates to gemini-event-mapper', () => {
    const adapter = new GeminiAdapter();
    const result = adapter.mapJsonToEvents!({ type: 'gemini:text', text: 'hi' });
    expect(result).toEqual([{ type: 'agent:text', text: 'hi' }]);
  });

  it('mapJsonToEvents maps gemini:turn-complete to agent:result', () => {
    const adapter = new GeminiAdapter();
    const result = adapter.mapJsonToEvents!({
      type: 'gemini:turn-complete',
      result: {},
    });
    expect(result).toEqual([{ type: 'agent:result', costUsd: null, turns: 1, durationMs: null }]);
  });

  // ---------------------------------------------------------------------------
  // Image support
  // ---------------------------------------------------------------------------

  it('passes image in sendMessage through to sendPrompt', async () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    // Wait for initial turn to complete
    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('gemini:turn-complete'))).toBeDefined();
    });

    // Capture what the next prompt() call receives
    let capturedPromptParams: Record<string, unknown> | null = null;
    mockConnection.prompt.mockImplementation((params: Record<string, unknown>) => {
      capturedPromptParams = params;
      return Promise.resolve({});
    });

    const image: ImageContent = { data: 'base64data', mimeType: 'image/png' };
    await adapter.sendMessage('describe this image', image);

    expect(capturedPromptParams).not.toBeNull();
    const prompt = capturedPromptParams!.prompt as Array<Record<string, unknown>>;
    expect(prompt).toHaveLength(2);
    expect(prompt[0]).toEqual({ type: 'text', text: 'describe this image' });
    expect(prompt[1]).toEqual({ type: 'image', data: 'base64data', mimeType: 'image/png' });
  });

  // ---------------------------------------------------------------------------
  // Interrupt escalation
  // ---------------------------------------------------------------------------

  it('sends session/cancel notification on interrupt', async () => {
    vi.useFakeTimers();
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);
    setupAutoResponder();

    // Flush microtasks to complete init chain (initialize → newSession → prompt)
    await vi.advanceTimersByTimeAsync(10);

    const interruptPromise = adapter.interrupt();

    // cancel() is called synchronously before the first await in interrupt()
    expect(mockConnection.cancel).toHaveBeenCalledWith({ sessionId: 'test-session-123' });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);

    await interruptPromise;
  });

  it('uses session/load when resuming with loadSession capability', async () => {
    // initialize() is called synchronously inside resume() — must configure before the call
    initializeImpl = () => Promise.resolve({ agentCapabilities: { loadSession: true } });

    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.resume('existing-sess-id', 'continue working', opts);
    proc.onData((chunk) => received.push(chunk));

    // loadSession and prompt are called after awaits — safe to configure here
    mockConnection.loadSession.mockResolvedValue(null);
    mockConnection.prompt.mockResolvedValue({ done: true });

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('gemini:turn-complete'))).toBeDefined();
    });

    // Verify session/load was used (not session/new)
    expect(mockConnection.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'existing-sess-id',
        cwd: '/tmp',
      }),
    );
    expect(mockConnection.newSession).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Non-JSON line handling — unknown sessionUpdate types are silently ignored
  // ---------------------------------------------------------------------------

  it('ignores non-JSON lines from the agent (unknown sessionUpdate type)', async () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await expect(
      capturedClientHandler!.sessionUpdate({
        update: { sessionUpdate: 'unknown_debug_line' },
      }),
    ).resolves.not.toThrow();
    expect(received).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // isAlive
  // ---------------------------------------------------------------------------

  it('isAlive returns true when stdin is writable', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);
    expect(adapter.isAlive()).toBe(true);
  });

  it('isAlive returns false when stdin is not writable', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);
    mockChildProcess.stdin.writable = false;
    expect(adapter.isAlive()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // PROMPT_TIMEOUT_MS exists
  // ---------------------------------------------------------------------------

  it('has a PROMPT_TIMEOUT_MS of 10 minutes', () => {
    expect(GeminiAdapter.PROMPT_TIMEOUT_MS).toBe(600_000);
  });

  // ---------------------------------------------------------------------------
  // Error handling: turn error emission
  // ---------------------------------------------------------------------------

  it('emits gemini:turn-error when sendPrompt ACP request fails', async () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    // initialize + newSession succeed, prompt rejects
    mockConnection.initialize.mockResolvedValue({ agentCapabilities: {} });
    mockConnection.newSession.mockResolvedValue({ sessionId: 'sess-1' });
    mockConnection.prompt.mockRejectedValue({ code: -32000, message: 'Context length exceeded' });

    await vi.waitFor(() => {
      const turnError = received.find((r) => r.includes('gemini:turn-error'));
      expect(turnError).toBeDefined();
    });

    const turnErrors = received.filter((r) => r.includes('gemini:turn-error'));
    // Should emit exactly ONE error (from sendPrompt), not a duplicate from initAndRun
    expect(turnErrors).toHaveLength(1);
    const parsed = JSON.parse(turnErrors[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('gemini:turn-error');
    expect(parsed.message).toContain('Context length exceeded');
    // Prompt errors should NOT have "Init failed:" prefix
    expect(parsed.message).not.toContain('Init failed:');
  });

  it('emits gemini:turn-error with "Init failed:" prefix for init errors', async () => {
    // initialize() is called synchronously inside spawn() — must configure before the call
    initializeImpl = () => Promise.reject({ code: -32603, message: 'Internal error' });

    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      const turnError = received.find((r) => r.includes('gemini:turn-error'));
      expect(turnError).toBeDefined();
    });

    const turnErrors = received.filter((r) => r.includes('gemini:turn-error'));
    // Exactly ONE error event
    expect(turnErrors).toHaveLength(1);
    const parsed = JSON.parse(turnErrors[0]) as Record<string, unknown>;
    expect(parsed.message).toContain('Init failed:');
    expect(parsed.message).toContain('Internal error');
  });

  // ---------------------------------------------------------------------------
  // onThinkingChange callback
  // ---------------------------------------------------------------------------

  it('calls thinkingCallback(true) before prompt and thinkingCallback(false) after', async () => {
    const adapter = new GeminiAdapter();
    const thinkingStates: boolean[] = [];
    adapter.onThinkingChange((thinking) => thinkingStates.push(thinking));
    adapter.spawn('test prompt', opts);
    setupAutoResponder();

    await vi.waitFor(() => {
      expect(thinkingStates).toContain(true);
      expect(thinkingStates).toContain(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-turn: sendMessage after init completes
  // ---------------------------------------------------------------------------

  it('supports multi-turn conversation via sendMessage', async () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('first prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    // Wait for initial turn to complete
    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('gemini:turn-complete'))).toBeDefined();
    });

    // Send a second message
    received.length = 0;
    await adapter.sendMessage('second message');

    // Should have emitted another turn-complete
    expect(received.find((r) => r.includes('gemini:turn-complete'))).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 429 errors surface as turn errors (no retry — Gemini duplicates messages)
  // ---------------------------------------------------------------------------

  it('surfaces 429 as gemini:turn-error without retrying', async () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    mockConnection.initialize.mockResolvedValue({ agentCapabilities: {} });
    mockConnection.newSession.mockResolvedValue({ sessionId: 'sess-429' });
    mockConnection.prompt.mockRejectedValue({ code: 429, message: '429 Rate limit exceeded' });

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('gemini:turn-error'))).toBeDefined();
    });

    // Should NOT have retried — Gemini ACP duplicates messages on retry
    expect(mockConnection.prompt).toHaveBeenCalledTimes(1);
    const error = JSON.parse(received.find((r) => r.includes('gemini:turn-error'))!) as Record<
      string,
      unknown
    >;
    expect(error.message).toContain('429');
  });
});
