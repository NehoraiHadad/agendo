import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @agentclientprotocol/sdk
// ---------------------------------------------------------------------------

type MockConnection = {
  initialize: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  unstable_resumeSession: ReturnType<typeof vi.fn>;
};

let mockConnection: MockConnection;

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: '1.0.0',
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function (
    this: unknown,
    _handlerFactory: (agent: null) => unknown,
    _stream: unknown,
  ) {
    Object.assign(this as object, mockConnection);
    return this;
  }),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { Readable, Writable } from 'node:stream';
import { GeminiAcpTransport } from '../gemini-acp-transport';
import type { AcpMcpServer } from '../types';

describe('GeminiAcpTransport', () => {
  let transport: GeminiAcpTransport;
  let fakeStdin: NodeJS.WritableStream;
  let fakeStdout: NodeJS.ReadableStream;

  // Minimal client handler mock
  const clientHandler = {} as Parameters<typeof GeminiAcpTransport.prototype.createConnection>[2];

  beforeEach(() => {
    // Fresh streams per test to avoid MaxListeners warnings
    fakeStdin = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    }) as NodeJS.WritableStream;
    fakeStdout = new Readable({ read() {} }) as unknown as NodeJS.ReadableStream;
    mockConnection = {
      initialize: vi.fn().mockResolvedValue({
        agentCapabilities: {},
        serverInfo: { name: 'gemini', version: '1.0' },
      }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'new-session-123' }),
      prompt: vi.fn().mockResolvedValue({ result: 'ok' }),
      loadSession: vi.fn().mockResolvedValue({}),
      unstable_resumeSession: vi.fn().mockResolvedValue({}),
    };
    transport = new GeminiAcpTransport();
  });

  describe('createConnection()', () => {
    it('creates a ClientSideConnection from stdin/stdout', () => {
      const conn = transport.createConnection(fakeStdin, fakeStdout, clientHandler);
      expect(conn).toBeDefined();
      expect(conn.initialize).toBeTypeOf('function');
    });
  });

  describe('initialize()', () => {
    it('sends ACP handshake and returns server info', async () => {
      transport.createConnection(fakeStdin, fakeStdout, clientHandler);

      const result = await transport.initialize();

      expect(mockConnection.initialize).toHaveBeenCalledWith({
        protocolVersion: '1.0.0',
        clientInfo: { name: 'agendo', version: '1.0.0' },
        clientCapabilities: {
          terminal: true,
          fs: { readTextFile: true, writeTextFile: true },
        },
      });
      expect(result.agentCapabilities).toEqual({});
    });

    it('retries on 429 with exponential backoff', async () => {
      vi.useFakeTimers();
      transport.createConnection(fakeStdin, fakeStdout, clientHandler);

      // First two calls fail with 429, third succeeds
      mockConnection.initialize
        .mockRejectedValueOnce({ message: '429 Rate limit exceeded' })
        .mockRejectedValueOnce({ message: '429 Rate limit exceeded' })
        .mockResolvedValueOnce({
          agentCapabilities: { loadSession: true },
          serverInfo: { name: 'gemini' },
        });

      const promise = transport.initialize();

      // Advance past 4s delay (attempt 1 backoff)
      await vi.advanceTimersByTimeAsync(4_000);
      // Advance past 8s delay (attempt 2 backoff)
      await vi.advanceTimersByTimeAsync(8_000);

      const result = await promise;

      expect(mockConnection.initialize).toHaveBeenCalledTimes(3);
      expect(result.agentCapabilities).toEqual({ loadSession: true });
      vi.useRealTimers();
    });

    it('throws after max retries on persistent 429', async () => {
      vi.useFakeTimers();
      transport.createConnection(fakeStdin, fakeStdout, clientHandler);

      mockConnection.initialize.mockRejectedValue({ message: '429 Rate limit exceeded' });

      // Attach a catch handler early to prevent unhandled rejection warnings
      const promise = transport.initialize().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(8_000);

      const err = await promise;
      expect(err).toEqual({ message: '429 Rate limit exceeded' });
      // 3 attempts total (initial + 2 retries)
      expect(mockConnection.initialize).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('throws immediately on non-429 errors', async () => {
      transport.createConnection(fakeStdin, fakeStdout, clientHandler);

      mockConnection.initialize.mockRejectedValue(new Error('Connection refused'));

      await expect(transport.initialize()).rejects.toThrow('Connection refused');
      expect(mockConnection.initialize).toHaveBeenCalledTimes(1);
    });

    it('throws if no connection exists', async () => {
      await expect(transport.initialize()).rejects.toThrow('No ACP connection');
    });
  });

  describe('loadOrCreateSession()', () => {
    beforeEach(() => {
      transport.createConnection(fakeStdin, fakeStdout, clientHandler);
    });

    it('creates a new session when no resumeSessionId', async () => {
      const sessionId = await transport.loadOrCreateSession(
        {},
        { cwd: '/tmp', mcpServers: [] },
        null,
      );

      expect(mockConnection.newSession).toHaveBeenCalledWith({
        cwd: '/tmp',
        mcpServers: [],
      });
      expect(sessionId).toBe('new-session-123');
    });

    it('tries resume → load → new fallback chain', async () => {
      const agentCaps = {
        sessionCapabilities: { resume: {} },
        loadSession: true,
      };

      // resume fails, load fails, new succeeds
      mockConnection.unstable_resumeSession.mockRejectedValue(new Error('resume failed'));
      mockConnection.loadSession.mockRejectedValue(new Error('load failed'));

      const sessionId = await transport.loadOrCreateSession(
        agentCaps,
        { cwd: '/tmp', mcpServers: [] },
        'existing-session-456',
      );

      expect(mockConnection.unstable_resumeSession).toHaveBeenCalledTimes(1);
      expect(mockConnection.loadSession).toHaveBeenCalledTimes(1);
      expect(mockConnection.newSession).toHaveBeenCalledTimes(1);
      expect(sessionId).toBe('new-session-123');
    });

    it('uses resume when agent supports it', async () => {
      const agentCaps = {
        sessionCapabilities: { resume: {} },
      };

      const sessionId = await transport.loadOrCreateSession(
        agentCaps,
        { cwd: '/work', mcpServers: [] },
        'resume-session-789',
      );

      expect(mockConnection.unstable_resumeSession).toHaveBeenCalledWith({
        sessionId: 'resume-session-789',
        cwd: '/work',
        mcpServers: [],
      });
      expect(sessionId).toBe('resume-session-789');
      expect(mockConnection.newSession).not.toHaveBeenCalled();
    });

    it('uses loadSession when resume is not supported', async () => {
      const agentCaps = {
        loadSession: true,
      };

      const sessionId = await transport.loadOrCreateSession(
        agentCaps,
        { cwd: '/work', mcpServers: [] },
        'load-session-101',
      );

      expect(mockConnection.unstable_resumeSession).not.toHaveBeenCalled();
      expect(mockConnection.loadSession).toHaveBeenCalledWith({
        sessionId: 'load-session-101',
        cwd: '/work',
        mcpServers: [],
      });
      expect(sessionId).toBe('load-session-101');
    });

    it('passes mcpServers through correctly', async () => {
      const mcpServers: AcpMcpServer[] = [
        { name: 'agendo', command: 'node', args: ['mcp.js'], env: [{ name: 'X', value: 'Y' }] },
      ];

      await transport.loadOrCreateSession({}, { cwd: '/tmp', mcpServers }, null);

      expect(mockConnection.newSession).toHaveBeenCalledWith({
        cwd: '/tmp',
        mcpServers,
      });
    });

    it('throws if no connection exists', async () => {
      const noConnTransport = new GeminiAcpTransport();
      await expect(
        noConnTransport.loadOrCreateSession({}, { cwd: '/tmp', mcpServers: [] }, null),
      ).rejects.toThrow('No ACP connection');
    });
  });

  describe('sendPrompt()', () => {
    beforeEach(() => {
      transport.createConnection(fakeStdin, fakeStdout, clientHandler);
    });

    it('sends text prompt with correct format', async () => {
      const result = await transport.sendPrompt('session-1', 'Hello world');

      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'Hello world' }],
      });
      expect(result).toEqual({ result: 'ok' });
    });

    it('sends text + image when image provided', async () => {
      const image = { data: 'base64data', mimeType: 'image/png' };
      await transport.sendPrompt('session-1', 'Describe this', image);

      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: 'session-1',
        prompt: [
          { type: 'text', text: 'Describe this' },
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
      });
    });

    it('throws if no connection exists', async () => {
      const noConnTransport = new GeminiAcpTransport();
      await expect(noConnTransport.sendPrompt('s', 'hi')).rejects.toThrow('No ACP connection');
    });

    it('propagates prompt errors', async () => {
      mockConnection.prompt.mockRejectedValue(new Error('Timeout'));
      await expect(transport.sendPrompt('session-1', 'test')).rejects.toThrow('Timeout');
    });
  });

  describe('getConnection()', () => {
    it('returns null when no connection created', () => {
      expect(transport.getConnection()).toBeNull();
    });

    it('returns the connection after createConnection()', () => {
      transport.createConnection(fakeStdin, fakeStdout, clientHandler);
      expect(transport.getConnection()).not.toBeNull();
    });
  });

  describe('setConnection()', () => {
    it('replaces the internal connection', () => {
      const fakeConn = { initialize: vi.fn() } as unknown as ReturnType<
        typeof transport.getConnection
      >;
      transport.setConnection(fakeConn!);
      expect(transport.getConnection()).toBe(fakeConn);
    });
  });
});
