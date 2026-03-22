import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// Mock child_process
type MockChildProcess = EventEmitter & {
  stdin: Writable & { writable: boolean };
  stdout: Readable;
  stderr: Readable;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as MockChildProcess;
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
    return proc;
  }),
}));

// Mock ACP SDK
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
  unstable_setSessionModel: ReturnType<typeof vi.fn>;
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
  unstable_setSessionModel: vi.fn(),
};

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
      unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
    };
    return mockConnection;
  }),
}));

import { spawn as nodeSpawn } from 'node:child_process';
import { CopilotAdapter } from '@/lib/worker/adapters/copilot-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
};

function setupAutoResponder(
  sessionId = 'test-session-123',
  promptResult: Record<string, unknown> = {},
): void {
  mockConnection.initialize.mockResolvedValue({ agentCapabilities: {} });
  mockConnection.newSession.mockResolvedValue({ sessionId });
  mockConnection.prompt.mockResolvedValue(promptResult);
  mockConnection.cancel.mockResolvedValue(undefined);
}

describe('CopilotAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedClientHandler = null;
    initializeImpl = () => Promise.resolve({ agentCapabilities: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Spawn args ---

  it('spawns copilot with --acp flag', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', opts);
    expect(nodeSpawn).toHaveBeenCalledWith(
      'copilot',
      expect.arrayContaining(['--acp']),
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('includes --no-auto-update and --disable-builtin-mcps', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', opts);
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--no-auto-update');
    expect(args).toContain('--disable-builtin-mcps');
  });

  it('passes --yolo for bypassPermissions', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'bypassPermissions' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--yolo');
  });

  it('passes --yolo for dontAsk', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'dontAsk' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--yolo');
  });

  it('passes --allow-all-tools --allow-all-paths for acceptEdits', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'acceptEdits' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--allow-all-tools');
    expect(args).toContain('--allow-all-paths');
  });

  it('passes --deny-tool flags for plan mode', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'plan' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--deny-tool=write');
    expect(args).toContain('--deny-tool=shell');
  });

  it('passes --model when model is specified', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', { ...opts, model: 'gpt-5.4' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.4');
  });

  it('passes --resume=<sessionId> when sessionId is provided', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', { ...opts, sessionId: 'my-uuid-123' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--resume=my-uuid-123');
  });

  it('passes --additional-mcp-config with JSON for MCP servers', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', {
      ...opts,
      mcpServers: [
        {
          name: 'agendo',
          command: 'node',
          args: ['dist/mcp-server.js'],
          env: [{ name: 'AGENDO_URL', value: 'http://localhost:4100' }],
        },
      ],
    });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--additional-mcp-config');
    const configIdx = args.indexOf('--additional-mcp-config');
    const configJson = JSON.parse(args[configIdx + 1]);
    expect(configJson.mcpServers.agendo).toEqual({
      command: 'node',
      args: ['dist/mcp-server.js'],
      env: { AGENDO_URL: 'http://localhost:4100' },
    });
  });

  // --- Managed process ---

  it('returns managed process with empty tmuxSession', () => {
    const adapter = new CopilotAdapter();
    const proc = adapter.spawn('test prompt', opts);
    expect(proc.tmuxSession).toBe('');
    expect(proc.pid).toBe(99999);
  });

  // --- ACP handshake ---

  it('sends initialize request with clientInfo', async () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', opts);
    await vi.waitFor(() => expect(mockConnection.initialize).toHaveBeenCalled());
    const [initParams] = mockConnection.initialize.mock.calls[0] as [Record<string, unknown>];
    expect(initParams.clientInfo).toEqual({ name: 'agendo', version: '1.0.0' });
  });

  // --- Session ID ---

  it('extractSessionId returns null before init', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', opts);
    expect(adapter.extractSessionId('')).toBeNull();
  });

  it('uses stored sessionId from resume', () => {
    const adapter = new CopilotAdapter();
    adapter.resume('session-xyz', 'continue', opts);
    expect(adapter.extractSessionId('')).toBe('session-xyz');
  });

  // --- NDJSON emission ---

  it('emits copilot:text-delta for agent_message_chunk', async () => {
    const adapter = new CopilotAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await capturedClientHandler!.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from Copilot!' },
      },
    });

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]);
    expect(parsed.type).toBe('copilot:text-delta');
    expect(parsed.text).toBe('Hello from Copilot!');
  });

  it('emits copilot:thinking-delta for agent_thought_chunk', async () => {
    const adapter = new CopilotAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await capturedClientHandler!.sessionUpdate({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking...' },
      },
    });

    const parsed = JSON.parse(received[0]);
    expect(parsed.type).toBe('copilot:thinking-delta');
  });

  // --- Turn completion ---

  it('emits copilot:turn-complete after sendPrompt resolves', async () => {
    const promptResult = { sessionId: 'test-session-123', done: true };
    const adapter = new CopilotAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder('test-session-123', promptResult);
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      const turnComplete = received.find((r) => r.includes('copilot:turn-complete'));
      expect(turnComplete).toBeDefined();
    });
  });

  // --- mapJsonToEvents ---

  it('has mapJsonToEvents that delegates to copilot-event-mapper', () => {
    const adapter = new CopilotAdapter();
    const result = adapter.mapJsonToEvents!({ type: 'copilot:text', text: 'hi' });
    expect(result).toEqual([{ type: 'agent:text', text: 'hi' }]);
  });

  // --- setModel uses ACP unstable_setSessionModel (no restart) ---

  it('setModel calls unstable_setSessionModel without restarting process', async () => {
    const adapter = new CopilotAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('copilot:turn-complete'))).toBeDefined();
    });

    const result = await adapter.setModel!('gpt-5.4');
    expect(result).toBe(true);
    expect(mockConnection.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: 'test-session-123',
      modelId: 'gpt-5.4',
    });
  });

  // --- Interrupt ---

  it('sends session/cancel on interrupt', async () => {
    vi.useFakeTimers();
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', opts);
    setupAutoResponder();
    await vi.advanceTimersByTimeAsync(10);

    const interruptPromise = adapter.interrupt();
    expect(mockConnection.cancel).toHaveBeenCalledWith({ sessionId: 'test-session-123' });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    await interruptPromise;
  });

  // --- isAlive ---

  it('isAlive returns true when stdin is writable', () => {
    const adapter = new CopilotAdapter();
    adapter.spawn('test prompt', opts);
    expect(adapter.isAlive()).toBe(true);
  });

  // --- No TOML commands (Copilot doesn't use them) ---

  it('does not emit commands events (no TOML loading)', async () => {
    const adapter = new CopilotAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('copilot:turn-complete'))).toBeDefined();
    });

    const commandEvents = received.filter((r) => r.includes('commands'));
    expect(commandEvents).toHaveLength(0);
  });

  // --- Resume with --resume= format ---

  it('passes --resume=<sessionRef> on resume', () => {
    const adapter = new CopilotAdapter();
    adapter.resume('sess-abc-123', 'continue', opts);
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--resume=sess-abc-123');
  });
});
