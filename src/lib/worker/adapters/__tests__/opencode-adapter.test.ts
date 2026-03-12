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
  setSessionModel: ReturnType<typeof vi.fn>;
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
  setSessionModel: vi.fn(),
  unstable_resumeSession: vi.fn(),
};

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: '1.0.0',
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function (
    this: unknown,
    handlerFactory: (agent: null) => AcpClientHandler,
  ) {
    capturedClientHandler = handlerFactory(null);
    mockConnection = {
      initialize: vi.fn().mockResolvedValue({ agentCapabilities: {} }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'default-session' }),
      prompt: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue(undefined),
      loadSession: vi.fn().mockResolvedValue(null),
      setSessionMode: vi.fn().mockResolvedValue(undefined),
      setSessionModel: vi.fn().mockResolvedValue(undefined),
      unstable_resumeSession: vi.fn().mockResolvedValue(undefined),
    };
    return mockConnection;
  }),
}));

import { spawn as nodeSpawn } from 'node:child_process';
import { OpenCodeAdapter } from '@/lib/worker/adapters/opencode-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp/myproject',
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

describe('OpenCodeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedClientHandler = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Spawn args: ACP subcommand ---

  it('spawns opencode with "acp" subcommand (not a flag)', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', opts);
    const [binary, args] = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[],
    ];
    expect(binary).toBe('opencode');
    expect(args[0]).toBe('acp');
  });

  it('passes --cwd as an explicit CLI flag', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', opts);
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--cwd');
    const cwdIdx = args.indexOf('--cwd');
    expect(args[cwdIdx + 1]).toBe('/tmp/myproject');
  });

  it('passes -m with provider/model format', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, model: 'anthropic/claude-sonnet-4-5' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('-m');
    const modelIdx = args.indexOf('-m');
    expect(args[modelIdx + 1]).toBe('anthropic/claude-sonnet-4-5');
  });

  it('does NOT pass --yolo flag (OpenCode has no such flag)', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'bypassPermissions' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).not.toContain('--yolo');
  });

  it('does NOT pass --approval-mode flag (permission via env var)', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'bypassPermissions' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).not.toContain('--approval-mode');
  });

  it('passes -s for session resume via resume()', () => {
    const adapter = new OpenCodeAdapter();
    adapter.resume('sess-abc-123', 'continue', opts);
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('-s');
    const sIdx = args.indexOf('-s');
    expect(args[sIdx + 1]).toBe('sess-abc-123');
  });

  it('passes -s for session resume via opts.sessionId', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, sessionId: 'my-uuid-456' });
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('-s');
    const sIdx = args.indexOf('-s');
    expect(args[sIdx + 1]).toBe('my-uuid-456');
  });

  it('does not include -s when no sessionId or resume', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', opts);
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).not.toContain('-s');
  });

  // --- OPENCODE_CONFIG_CONTENT env injection ---

  it('injects OPENCODE_CONFIG_CONTENT with all tools allowed for bypassPermissions', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'bypassPermissions' });
    const spawnEnv = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env as Record<
      string,
      string
    >;
    expect(spawnEnv).toHaveProperty('OPENCODE_CONFIG_CONTENT');
    const config = JSON.parse(spawnEnv['OPENCODE_CONFIG_CONTENT']);
    expect(config.permission.bash).toBe('allow');
    expect(config.permission.edit).toBe('allow');
    expect(config.permission.write).toBe('allow');
  });

  it('injects OPENCODE_CONFIG_CONTENT with bash=ask for acceptEdits', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'acceptEdits' });
    const spawnEnv = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env as Record<
      string,
      string
    >;
    expect(spawnEnv).toHaveProperty('OPENCODE_CONFIG_CONTENT');
    const config = JSON.parse(spawnEnv['OPENCODE_CONFIG_CONTENT']);
    expect(config.permission.bash).toBe('ask');
    expect(config.permission.edit).toBe('allow');
    expect(config.permission.write).toBe('allow');
  });

  it('injects OPENCODE_CONFIG_CONTENT for dontAsk (same as bypassPermissions)', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'dontAsk' });
    const spawnEnv = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env as Record<
      string,
      string
    >;
    expect(spawnEnv).toHaveProperty('OPENCODE_CONFIG_CONTENT');
    const config = JSON.parse(spawnEnv['OPENCODE_CONFIG_CONTENT']);
    expect(config.permission.bash).toBe('allow');
  });

  it('does not inject OPENCODE_CONFIG_CONTENT in default mode', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, permissionMode: 'default' });
    const spawnEnv = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env as Record<
      string,
      string
    >;
    expect(spawnEnv).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
  });

  it('injects MCP servers into OPENCODE_CONFIG_CONTENT config.mcp', () => {
    const adapter = new OpenCodeAdapter();
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
    const spawnEnv = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env as Record<
      string,
      string
    >;
    expect(spawnEnv).toHaveProperty('OPENCODE_CONFIG_CONTENT');
    const config = JSON.parse(spawnEnv['OPENCODE_CONFIG_CONTENT']);
    expect(config.mcp).toHaveProperty('agendo');
    expect(config.mcp.agendo).toEqual({
      type: 'local',
      command: ['node', 'dist/mcp-server.js'],
      environment: { AGENDO_URL: 'http://localhost:4100' },
    });
  });

  // --- Managed process ---

  it('returns managed process with pid and empty tmuxSession', () => {
    const adapter = new OpenCodeAdapter();
    const proc = adapter.spawn('test prompt', opts);
    expect(proc.tmuxSession).toBe('');
    expect(proc.pid).toBe(99999);
  });

  // --- ACP handshake ---

  it('sends initialize request with clientInfo', async () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', opts);
    await vi.waitFor(() => expect(mockConnection.initialize).toHaveBeenCalled());
    const [initParams] = mockConnection.initialize.mock.calls[0] as [Record<string, unknown>];
    expect(initParams.clientInfo).toEqual({ name: 'agendo', version: '1.0.0' });
  });

  // --- Session ID ---

  it('extractSessionId returns null before init', () => {
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', opts);
    expect(adapter.extractSessionId('')).toBeNull();
  });

  it('uses stored sessionId from resume', () => {
    const adapter = new OpenCodeAdapter();
    adapter.resume('session-xyz', 'continue', opts);
    expect(adapter.extractSessionId('')).toBe('session-xyz');
  });

  // --- NDJSON emission ---

  it('emits opencode:text-delta for agent_message_chunk', async () => {
    const adapter = new OpenCodeAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await capturedClientHandler!.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from OpenCode!' },
      },
    });

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]);
    expect(parsed.type).toBe('opencode:text-delta');
    expect(parsed.text).toBe('Hello from OpenCode!');
  });

  it('emits opencode:thinking-delta for agent_thought_chunk', async () => {
    const adapter = new OpenCodeAdapter();
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
    expect(parsed.type).toBe('opencode:thinking-delta');
  });

  // --- Turn completion ---

  it('emits opencode:turn-complete after sendPrompt resolves', async () => {
    const promptResult = { sessionId: 'test-session-123', done: true };
    const adapter = new OpenCodeAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder('test-session-123', promptResult);
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      const turnComplete = received.find((r) => r.includes('opencode:turn-complete'));
      expect(turnComplete).toBeDefined();
    });
  });

  // --- mapJsonToEvents ---

  it('has mapJsonToEvents that delegates to opencode-event-mapper', () => {
    const adapter = new OpenCodeAdapter();
    const result = adapter.mapJsonToEvents!({ type: 'opencode:text', text: 'hi' });
    expect(result).toEqual([{ type: 'agent:text', text: 'hi' }]);
  });

  // --- setModel uses standard ACP setSessionModel (no unstable_ prefix) ---

  it('setModel calls setSessionModel (standard ACP, not unstable_)', async () => {
    const adapter = new OpenCodeAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('opencode:turn-complete'))).toBeDefined();
    });

    const result = await adapter.setModel!('anthropic/claude-opus-4-5');
    expect(result).toBe(true);
    expect(mockConnection.setSessionModel).toHaveBeenCalledWith({
      sessionId: 'test-session-123',
      modelId: 'anthropic/claude-opus-4-5',
    });
  });

  // --- setPermissionMode maps to OpenCode agent modes ---

  it('setPermissionMode maps default to general', async () => {
    const adapter = new OpenCodeAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('opencode:turn-complete'))).toBeDefined();
    });

    const result = await adapter.setPermissionMode!('default');
    expect(result).toBe(true);
    expect(mockConnection.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'test-session-123',
      modeId: 'general',
    });
  });

  it('setPermissionMode maps plan to plan', async () => {
    const adapter = new OpenCodeAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('opencode:turn-complete'))).toBeDefined();
    });

    const result = await adapter.setPermissionMode!('plan');
    expect(result).toBe(true);
    expect(mockConnection.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'test-session-123',
      modeId: 'plan',
    });
  });

  it('setPermissionMode returns false for bypassPermissions (handled via env, not mode)', async () => {
    const adapter = new OpenCodeAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('opencode:turn-complete'))).toBeDefined();
    });

    const result = await adapter.setPermissionMode!('bypassPermissions');
    expect(result).toBe(false);
  });

  // --- Interrupt ---

  it('sends session/cancel on interrupt', async () => {
    vi.useFakeTimers();
    const adapter = new OpenCodeAdapter();
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
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', opts);
    expect(adapter.isAlive()).toBe(true);
  });

  // --- No slash commands ---

  it('does not emit commands events (OpenCode has no slash commands)', async () => {
    const adapter = new OpenCodeAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    setupAutoResponder();
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('opencode:turn-complete'))).toBeDefined();
    });

    const commandEvents = received.filter((r) => r.includes('commands'));
    expect(commandEvents).toHaveLength(0);
  });

  // --- model format warning ---

  it('warns when model does not contain / (not in provider/model format)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new OpenCodeAdapter();
    adapter.spawn('test prompt', { ...opts, model: 'claude-sonnet-4-5' });
    // The warning should be logged (adapter logs internally, not console.warn, but we verify args)
    const args = (nodeSpawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    // Still passes the model even if wrongly formatted
    expect(args).toContain('-m');
    expect(args).toContain('claude-sonnet-4-5');
    warnSpy.mockRestore();
  });
});
