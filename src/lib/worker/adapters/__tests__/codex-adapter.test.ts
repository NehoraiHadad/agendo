import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared before imports
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockCallTool = vi.fn().mockResolvedValue({ content: [] });
const mockSetNotificationHandler = vi.fn();
const mockSetRequestHandler = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
    setNotificationHandler: mockSetNotificationHandler,
    setRequestHandler: mockSetRequestHandler,
    close: mockClose,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    onclose: null as (() => void) | null,
    pid: 54321,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  LoggingMessageNotificationSchema: {},
  ElicitRequestSchema: {},
}));

import { CodexAdapter } from '@/lib/worker/adapters/codex-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
};

describe('CodexAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({ content: [] });
    mockClose.mockResolvedValue(undefined);
  });

  it('registers notification and request handlers on spawn', () => {
    const adapter = new CodexAdapter();
    adapter.spawn('test prompt', opts);
    expect(mockSetNotificationHandler).toHaveBeenCalled();
    expect(mockSetRequestHandler).toHaveBeenCalled();
  });

  it('returns managed process with empty tmuxSession and pid=0', () => {
    const adapter = new CodexAdapter();
    const proc = adapter.spawn('test prompt', opts);
    expect(proc.tmuxSession).toBe('');
    expect(proc.pid).toBe(0);
  });

  it('connects to MCP server and calls codex tool on first turn', async () => {
    const adapter = new CodexAdapter();
    adapter.spawn('test prompt', opts);

    // Let microtasks drain (connect + callTool are mocked as resolved)
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockConnect).toHaveBeenCalled();
    expect(mockCallTool).toHaveBeenCalledWith(
      { name: 'codex', arguments: { prompt: 'test prompt', cwd: '/tmp' } },
      undefined,
      expect.objectContaining({ timeout: 300_000 }),
    );
  });

  it('extracts threadId from callTool response content', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ threadId: 'thread-abc' }) }],
    });

    const adapter = new CodexAdapter();
    adapter.spawn('test prompt', opts);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adapter.extractSessionId('')).toBe('thread-abc');
  });

  it('uses codex-reply tool on resume', async () => {
    const adapter = new CodexAdapter();
    adapter.resume('existing-thread', 'continue working', opts);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockCallTool).toHaveBeenCalledWith(
      {
        name: 'codex-reply',
        arguments: { prompt: 'continue working', threadId: 'existing-thread' },
      },
      undefined,
      expect.anything(),
    );
  });

  it('sendMessage waits for initial turn then calls codex-reply', async () => {
    mockCallTool
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ threadId: 'thread-123' }) }],
      })
      .mockResolvedValueOnce({ content: [] });

    const adapter = new CodexAdapter();
    adapter.spawn('test prompt', opts);

    // Wait for spawn's async chain to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    await adapter.sendMessage('follow-up question');

    expect(mockCallTool).toHaveBeenCalledTimes(2);
    expect(mockCallTool).toHaveBeenLastCalledWith(
      {
        name: 'codex-reply',
        arguments: { prompt: 'follow-up question', threadId: 'thread-123' },
      },
      undefined,
      expect.anything(),
    );
  });
});
