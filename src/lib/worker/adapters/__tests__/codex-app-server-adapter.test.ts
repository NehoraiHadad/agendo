import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock heavy dependencies so we can instantiate CodexAppServerAdapter
// without actually spawning processes.
// ---------------------------------------------------------------------------

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/worker/tmux-manager', () => ({
  createSession: vi.fn(),
}));

// We need to import the class AFTER mocks are set up
import { CodexAppServerAdapter } from '../codex-app-server-adapter';
import { NdjsonRpcTransport } from '../ndjson-rpc-transport';

// ---------------------------------------------------------------------------
// Helper: wire up a real NdjsonRpcTransport with a fake stdin, then inject
// it into the adapter via the private `_transport` field so we can test
// setModel() and notification handling without spawning a process.
// ---------------------------------------------------------------------------

function setupAdapter(): {
  adapter: CodexAppServerAdapter;
  transport: NdjsonRpcTransport;
  written: string[];
  onNotification: (method: string, params: Record<string, unknown>) => void;
  emitted: Array<Record<string, unknown>>;
} {
  const adapter = new CodexAppServerAdapter();
  const written: string[] = [];
  const fakeStdin = {
    writable: true,
    write: (data: string) => written.push(data),
  };

  // Capture the notification handler the adapter wires up
  let notificationHandler: (method: string, params: Record<string, unknown>) => void = () => {};

  const transport = new NdjsonRpcTransport({
    getStdin: () => fakeStdin as unknown as NodeJS.WritableStream,
    onServerRequest: vi.fn(),
    onNotification: (method, params) => notificationHandler(method, params),
  });

  // Inject transport into adapter (private field)

  (adapter as any)._transport = transport;

  // Capture emitted synthetic events via the dataCallbacks
  const emitted: Array<Record<string, unknown>> = [];

  (adapter as any).dataCallbacks = [
    (chunk: string) => {
      try {
        emitted.push(JSON.parse(chunk.trim()));
      } catch {
        // non-JSON
      }
    },
  ];

  // Wire notification handler to the adapter's private handleNotification

  notificationHandler = (adapter as any).handleNotification.bind(adapter);

  return { adapter, transport, written, onNotification: notificationHandler, emitted };
}

describe('CodexAppServerAdapter', () => {
  describe('setModel()', () => {
    it('sends setDefaultModel RPC with correct params', async () => {
      const { adapter, transport, written } = setupAdapter();

      // Resolve the RPC immediately by feeding back a response
      const promise = adapter.setModel('o4-mini');

      // Parse the sent message to get the request id
      const sent = JSON.parse(written[0].trimEnd());
      expect(sent).toEqual({
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'setDefaultModel',
        params: { model: 'o4-mini', reasoningEffort: null },
      });

      // Feed back a successful response
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: {} }));

      const result = await promise;
      expect(result).toBe(true);
    });

    it('returns false on RPC failure', async () => {
      const { adapter, transport, written } = setupAdapter();

      const promise = adapter.setModel('nonexistent-model');

      const sent = JSON.parse(written[0].trimEnd());
      transport.processLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: sent.id,
          error: { code: -32600, message: 'Invalid model' },
        }),
      );

      const result = await promise;
      expect(result).toBe(false);
    });

    it('updates local model field on success', async () => {
      const { adapter, transport, written } = setupAdapter();

      const promise = adapter.setModel('gpt-4.1');
      const sent = JSON.parse(written[0].trimEnd());
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: {} }));
      await promise;

      expect((adapter as any).model).toBe('gpt-4.1');
    });
  });

  describe('notification handling', () => {
    it('handles sessionConfigured and emits info event', () => {
      const { onNotification, emitted, adapter } = setupAdapter();

      onNotification('sessionConfigured', {
        model: 'o4-mini',
        sessionId: 'thread-1',
        reasoningEffort: null,
        historyLogId: BigInt(0),
        historyEntryCount: 0,
        initialMessages: null,
        rolloutPath: '',
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual({
        type: 'as:info',
        message: 'Model set to o4-mini',
      });

      expect((adapter as any).model).toBe('o4-mini');
    });

    it('handles model/rerouted and updates model to target', () => {
      const { onNotification, emitted, adapter } = setupAdapter();

      onNotification('model/rerouted', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        fromModel: 'o4-mini',
        toModel: 'gpt-4.1-mini',
        reason: 'model_unavailable',
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: 'as:info',
        message: expect.stringContaining('o4-mini'),
      });
      expect(emitted[0].message).toContain('gpt-4.1-mini');

      expect((adapter as any).model).toBe('gpt-4.1-mini');
    });

    it('handles thread/tokenUsage/updated with real modelContextWindow', () => {
      const { onNotification, emitted, adapter } = setupAdapter();

      onNotification('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 45000,
            inputTokens: 30000,
            cachedInputTokens: 5000,
            outputTokens: 8000,
            reasoningOutputTokens: 2000,
          },
          last: {
            totalTokens: 5000,
            inputTokens: 3000,
            cachedInputTokens: 0,
            outputTokens: 1500,
            reasoningOutputTokens: 500,
          },
          modelContextWindow: 128000,
        },
      });

      // Should emit as:usage with real context window
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual({
        type: 'as:usage',
        used: 45000,
        size: 128000,
      });

      // Internal tokenUsage should reflect real values
      const tokenUsage = (adapter as any).tokenUsage;
      expect(tokenUsage).toEqual({ used: 45000, limit: 128000 });
    });

    it('falls back to 200K when modelContextWindow is null', () => {
      const { onNotification, emitted } = setupAdapter();

      onNotification('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 10000,
            inputTokens: 7000,
            cachedInputTokens: 1000,
            outputTokens: 1500,
            reasoningOutputTokens: 500,
          },
          last: {
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: null,
        },
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual({
        type: 'as:usage',
        used: 10000,
        size: 200000,
      });
    });

    it('handles turn/diff/updated and emits diff event', () => {
      const { onNotification, emitted } = setupAdapter();

      const diff = `--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,3 +1,4 @@\n import { run } from './app';\n+import { logger } from './logger';\n run();`;

      onNotification('turn/diff/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        diff,
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual({
        type: 'as:diff-update',
        diff,
      });
    });

    it('ignores turn/diff/updated with empty diff', () => {
      const { onNotification, emitted } = setupAdapter();

      onNotification('turn/diff/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        diff: '',
      });

      expect(emitted).toHaveLength(0);
    });
  });

  describe('server request handling (item/tool/call)', () => {
    it('responds to dynamic tool calls with error (not implemented)', () => {
      const adapter = new CodexAppServerAdapter();
      const written: string[] = [];
      const fakeStdin = {
        writable: true,
        write: (data: string) => written.push(data),
      };

      let serverRequestHandler: (
        id: number,
        method: string,
        params: Record<string, unknown>,
      ) => void = () => {};

      const transport = new NdjsonRpcTransport({
        getStdin: () => fakeStdin as unknown as NodeJS.WritableStream,
        onServerRequest: (id, method, params) => serverRequestHandler(id, method, params),
        onNotification: vi.fn(),
      });

      (adapter as any)._transport = transport;

      const emitted: Array<Record<string, unknown>> = [];
      (adapter as any).dataCallbacks = [
        (chunk: string) => {
          try {
            emitted.push(JSON.parse(chunk.trim()));
          } catch {
            /* non-JSON */
          }
        },
      ];

      serverRequestHandler = (adapter as any).handleServerRequest.bind(adapter);

      // Simulate item/tool/call server request
      serverRequestHandler(42, 'item/tool/call', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-abc',
        tool: 'my_custom_tool',
        arguments: { key: 'value' },
      });

      // Should have emitted an info event
      // Note: handleServerRequest is async, but respond() is synchronous
      // Give it a tick to resolve
      setTimeout(() => {
        expect(
          emitted.some(
            (e) => e.type === 'as:info' && (e.message as string).includes('my_custom_tool'),
          ),
        ).toBe(true);

        // Should have responded with { success: false }
        const response = JSON.parse(written[written.length - 1].trimEnd());
        expect(response.result.success).toBe(false);
      }, 10);
    });
  });
});
