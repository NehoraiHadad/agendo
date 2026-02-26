import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

const mockStdinWrite = vi.fn((_data: string) => true);
let mockReadlineEmitter: EventEmitter;
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
    mockChildProcess = proc;
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
import type { SpawnOpts, ImageContent } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
};

/**
 * Set up an auto-responder that watches for ACP requests and sends
 * canned responses. This handles the async timing issue where
 * session/new request is only registered after initialize resolves.
 */
function setupAutoResponder(
  sessionId = 'test-session-123',
  promptResult: Record<string, unknown> = {},
): void {
  mockStdinWrite.mockImplementation((data: string) => {
    try {
      const msg = JSON.parse(data) as { id?: number; method?: string };
      if (msg.method === 'initialize' && msg.id !== undefined) {
        queueMicrotask(() => {
          mockReadlineEmitter.emit(
            'line',
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { agentCapabilities: {} } }),
          );
        });
      } else if (msg.method === 'session/new' && msg.id !== undefined) {
        queueMicrotask(() => {
          mockReadlineEmitter.emit(
            'line',
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId } }),
          );
        });
      } else if (msg.method === 'session/prompt' && msg.id !== undefined) {
        queueMicrotask(() => {
          mockReadlineEmitter.emit(
            'line',
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: promptResult }),
          );
        });
      }
    } catch {
      // Not JSON, ignore
    }
    return true;
  });
}

describe('GeminiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default (no auto-respond) — tests that need it call setupAutoResponder()
    mockStdinWrite.mockImplementation(() => true);
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

  it('sends initialize request with clientInfo and terminal capability', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);

    expect(mockStdinWrite).toHaveBeenCalled();
    const firstWrite = JSON.parse(mockStdinWrite.mock.calls[0][0]) as Record<string, unknown>;
    expect(firstWrite.method).toBe('initialize');
    expect(firstWrite.jsonrpc).toBe('2.0');
    const params = firstWrite.params as Record<string, unknown>;
    expect(params.clientInfo).toEqual({ name: 'agendo', version: '1.0.0' });
    const caps = params.clientCapabilities as Record<string, unknown>;
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

  it('emits gemini:text NDJSON for agent_message_chunk notifications', () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from Gemini!' },
        },
      },
    });
    mockReadlineEmitter.emit('line', notification);

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('gemini:text');
    expect(parsed.text).toBe('Hello from Gemini!');
  });

  it('emits gemini:thinking NDJSON for agent_thought_chunk notifications', () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Thinking about it...' },
        },
      },
    });
    mockReadlineEmitter.emit('line', notification);

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('gemini:thinking');
    expect(parsed.text).toBe('Thinking about it...');
  });

  // ---------------------------------------------------------------------------
  // Turn completion: emits gemini:turn-complete
  // ---------------------------------------------------------------------------

  it('emits gemini:turn-complete NDJSON after sendPrompt resolves', async () => {
    const promptResult = { sessionId: 'test-session-123', done: true };
    setupAutoResponder('test-session-123', promptResult);

    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      const turnComplete = received.find((r) => r.includes('gemini:turn-complete'));
      expect(turnComplete).toBeDefined();
    });

    const turnComplete = received.find((r) => r.includes('gemini:turn-complete'));
    const parsed = JSON.parse(turnComplete!) as Record<string, unknown>;
    expect(parsed.type).toBe('gemini:turn-complete');
    expect(parsed.result).toEqual(promptResult);
  });

  // ---------------------------------------------------------------------------
  // Tool approval: emits gemini:tool-start and gemini:tool-end
  // ---------------------------------------------------------------------------

  it('emits gemini:tool-start and gemini:tool-end for permission requests (auto-approve)', () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    const serverRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 'srv-req-1',
      method: 'session/request_permission',
      params: {
        toolCall: { title: 'Bash', rawInput: { command: 'ls -la' } },
        options: [{ kind: 'allow_once', optionId: 'opt-1', name: 'Allow once' }],
      },
    });
    mockReadlineEmitter.emit('line', serverRequest);

    const toolStart = received.find((r) => r.includes('gemini:tool-start'));
    const toolEnd = received.find((r) => r.includes('gemini:tool-end'));
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();

    const parsedStart = JSON.parse(toolStart!) as Record<string, unknown>;
    expect(parsedStart.toolName).toBe('Bash');
    expect(parsedStart.toolInput).toEqual({ command: 'ls -la' });

    const writes = mockStdinWrite.mock.calls.map(
      (c) => JSON.parse(c[0]) as Record<string, unknown>,
    );
    const response = writes.find((w) => w.id === 'srv-req-1' && w.result !== undefined);
    expect(response).toBeDefined();
    const outcome = (response!.result as Record<string, unknown>).outcome as Record<
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
    setupAutoResponder();

    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    // Wait for init+first prompt to finish
    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('gemini:turn-complete'))).toBeDefined();
    });

    // Replace auto-responder to capture the next prompt request instead of auto-responding
    let capturedPromptParams: Record<string, unknown> | null = null;
    mockStdinWrite.mockImplementation((data: string) => {
      try {
        const msg = JSON.parse(data) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (msg.method === 'session/prompt' && msg.id !== undefined) {
          capturedPromptParams = msg.params ?? null;
          // Respond to unblock sendMessage
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }),
            );
          });
        }
      } catch {
        // Not JSON
      }
      return true;
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
    setupAutoResponder();
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);

    // Wait for init to complete so sessionId is set
    await vi.advanceTimersByTimeAsync(10);

    const interruptPromise = adapter.interrupt();

    // Check that session/cancel was sent (notification — no id)
    const cancelWrite = mockStdinWrite.mock.calls.find((c) => {
      try {
        const msg = JSON.parse(c[0]) as Record<string, unknown>;
        return msg.method === 'session/cancel';
      } catch {
        return false;
      }
    });
    expect(cancelWrite).toBeDefined();
    const cancelMsg = JSON.parse(cancelWrite![0]) as Record<string, unknown>;
    expect(cancelMsg.id).toBeUndefined(); // notification, not request
    expect((cancelMsg.params as Record<string, unknown>).sessionId).toBe('test-session-123');

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);

    await interruptPromise;
  });

  it('uses session/load when resuming with loadSession capability', async () => {
    // Auto-respond: initialize returns loadSession: true, session/load succeeds
    mockStdinWrite.mockImplementation((data: string) => {
      try {
        const msg = JSON.parse(data) as { id?: number; method?: string };
        if (msg.method === 'initialize' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: { agentCapabilities: { loadSession: true } },
              }),
            );
          });
        } else if (msg.method === 'session/load' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }),
            );
          });
        } else if (msg.method === 'session/prompt' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { done: true } }),
            );
          });
        }
      } catch {
        // Not JSON
      }
      return true;
    });

    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.resume('existing-sess-id', 'continue working', opts);
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('gemini:turn-complete'))).toBeDefined();
    });

    // Verify session/load was called (not session/new)
    const writes = mockStdinWrite.mock.calls.map((c) => {
      try {
        return JSON.parse(c[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
    expect(writes.find((w) => w?.method === 'session/load')).toBeDefined();
    expect(writes.find((w) => w?.method === 'session/new')).toBeUndefined();

    // Verify session/load params
    const loadMsg = writes.find((w) => w?.method === 'session/load')!;
    const loadParams = loadMsg.params as Record<string, unknown>;
    expect(loadParams.sessionId).toBe('existing-sess-id');
    expect(loadParams.cwd).toBe('/tmp');
  });

  // ---------------------------------------------------------------------------
  // Non-JSON line handling
  // ---------------------------------------------------------------------------

  it('ignores non-JSON stdout lines', () => {
    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    expect(() => mockReadlineEmitter.emit('line', 'Loading... (debug)')).not.toThrow();
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
    // Auto-respond to init, but send error for prompt
    mockStdinWrite.mockImplementation((data: string) => {
      try {
        const msg = JSON.parse(data) as { id?: number; method?: string };
        if (msg.method === 'initialize' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { agentCapabilities: {} } }),
            );
          });
        } else if (msg.method === 'session/new' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } }),
            );
          });
        } else if (msg.method === 'session/prompt' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32000, message: 'Context length exceeded' },
              }),
            );
          });
        }
      } catch {
        // Not JSON
      }
      return true;
    });

    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

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
    // Respond to initialize with an error
    mockStdinWrite.mockImplementation((data: string) => {
      try {
        const msg = JSON.parse(data) as { id?: number; method?: string };
        if (msg.method === 'initialize' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32603, message: 'Internal error' },
              }),
            );
          });
        }
      } catch {
        // Not JSON
      }
      return true;
    });

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
    setupAutoResponder();

    const adapter = new GeminiAdapter();
    const thinkingStates: boolean[] = [];
    adapter.onThinkingChange((thinking) => thinkingStates.push(thinking));
    adapter.spawn('test prompt', opts);

    await vi.waitFor(() => {
      expect(thinkingStates).toContain(true);
      expect(thinkingStates).toContain(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-turn: sendMessage after init completes
  // ---------------------------------------------------------------------------

  it('supports multi-turn conversation via sendMessage', async () => {
    setupAutoResponder();

    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('first prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    // Wait for initial turn to complete
    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('gemini:turn-complete'))).toBeDefined();
    });

    // Send a second message
    received.length = 0; // clear
    await adapter.sendMessage('second message');

    // Should have emitted another turn-complete
    expect(received.find((r) => r.includes('gemini:turn-complete'))).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 429 errors surface as turn errors (no retry — Gemini duplicates messages)
  // ---------------------------------------------------------------------------

  it('surfaces 429 as gemini:turn-error without retrying', async () => {
    let promptAttempt = 0;

    mockStdinWrite.mockImplementation((data: string) => {
      try {
        const msg = JSON.parse(data) as { id?: number; method?: string };
        if (msg.method === 'initialize' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { agentCapabilities: {} } }),
            );
          });
        } else if (msg.method === 'session/new' && msg.id !== undefined) {
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-429' } }),
            );
          });
        } else if (msg.method === 'session/prompt' && msg.id !== undefined) {
          promptAttempt++;
          queueMicrotask(() => {
            mockReadlineEmitter.emit(
              'line',
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: 429, message: 'Rate limit exceeded' },
              }),
            );
          });
        }
      } catch {
        // Not JSON
      }
      return true;
    });

    const adapter = new GeminiAdapter();
    const received: string[] = [];
    const proc = adapter.spawn('test prompt', opts);
    proc.onData((chunk) => received.push(chunk));

    await vi.waitFor(() => {
      expect(received.find((r) => r.includes('gemini:turn-error'))).toBeDefined();
    });

    // Should NOT have retried — Gemini ACP duplicates messages on retry
    expect(promptAttempt).toBe(1);
    const error = JSON.parse(received.find((r) => r.includes('gemini:turn-error'))!) as Record<
      string,
      unknown
    >;
    expect(error.message).toContain('429');
  });
});
