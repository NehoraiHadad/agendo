import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AttachmentRef } from '@/lib/attachments';

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

  describe('sendMessage()', () => {
    it('sends attachment manifest text and localImage inputs for image attachments', async () => {
      const { adapter, transport, written } = setupAdapter();
      (adapter as any).threadId = 'thread-1';

      const attachment: AttachmentRef = {
        id: 'att-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 4,
        kind: 'image',
        path: '/workspace/.agendo/attachments/thread-1/diagram.png',
        sha256: 'deadbeef',
      };

      const promise = adapter.sendMessage('describe this diagram', [attachment]);

      const sent = JSON.parse(written[0].trimEnd());
      expect(sent).toMatchObject({
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          input: [
            {
              type: 'text',
              text: expect.stringContaining('describe this diagram'),
              text_elements: [],
            },
            {
              type: 'localImage',
              path: attachment.path,
            },
          ],
        },
      });
      expect(sent.params.input[0].text).toContain('Attached files available in the workspace:');
      expect(sent.params.input[0].text).toContain(attachment.path);

      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: {} }));
      await promise;
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
            totalTokens: 45000,
            inputTokens: 30000,
            cachedInputTokens: 15000,
            outputTokens: 0,
            reasoningOutputTokens: 0,
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
            totalTokens: 10000,
            inputTokens: 7000,
            cachedInputTokens: 3000,
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

  describe('compaction trigger behavior', () => {
    it('does not auto-trigger compaction from token usage updates', () => {
      const { onNotification, emitted, adapter, written } = setupAdapter();

      (adapter as any).alive = true;
      (adapter as any).threadId = 'thread-1';

      onNotification('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: {
            totalTokens: 170000,
            inputTokens: 170000,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200000,
        },
      });

      expect(emitted).toContainEqual({
        type: 'as:usage',
        used: 170000,
        size: 200000,
      });
      expect(emitted.filter((e) => e.type === 'as:compact-start')).toHaveLength(0);
      expect(
        written.some((line) => {
          try {
            return JSON.parse(line.trimEnd()).method === 'thread/compact/start';
          } catch {
            return false;
          }
        }),
      ).toBe(false);
    });

    it('does not trigger manual compaction again within the cooldown period', async () => {
      const { adapter, transport, written, onNotification } = setupAdapter();

      (adapter as any).alive = true;
      (adapter as any).threadId = 'thread-1';

      const firstCompactPromise = (adapter as any).triggerCompaction();
      const firstRequest = JSON.parse(written[0].trimEnd());
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: firstRequest.id, result: {} }));
      await firstCompactPromise;

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      await (adapter as any).triggerCompaction();

      const compactRequests = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter((msg) => !!msg && msg.method === 'thread/compact/start');

      expect(compactRequests).toHaveLength(1);
    });

    it('allows manual compaction again after the cooldown period expires', async () => {
      vi.useFakeTimers();
      const { adapter, transport, written, onNotification } = setupAdapter();

      (adapter as any).alive = true;
      (adapter as any).threadId = 'thread-1';

      const firstCompactPromise = (adapter as any).triggerCompaction();
      const firstRequest = JSON.parse(written[0].trimEnd());
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: firstRequest.id, result: {} }));
      await firstCompactPromise;

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      vi.advanceTimersByTime(61_000);

      const secondCompactPromise = (adapter as any).triggerCompaction();
      const secondRequest = JSON.parse(written[1].trimEnd());
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: secondRequest.id, result: {} }));
      await secondCompactPromise;

      const compactRequests = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter((msg) => !!msg && msg.method === 'thread/compact/start');

      expect(compactRequests).toHaveLength(2);

      vi.useRealTimers();
    });
  });

  describe('automatic resume after compaction', () => {
    it('keeps thinking active while a Codex-initiated compaction is being auto-resumed', async () => {
      const { adapter, transport, written, onNotification, emitted } = setupAdapter();
      const thinkingStates: boolean[] = [];

      adapter.onThinkingChange((thinking) => thinkingStates.push(thinking));
      (adapter as any).threadId = 'thread-1';

      const firstTurnPromise = (adapter as any).startTurn('Continue working');
      const firstTurnRequest = JSON.parse(written[0].trimEnd());
      transport.processLine(
        JSON.stringify({ jsonrpc: '2.0', id: firstTurnRequest.id, result: {} }),
      );
      await firstTurnPromise;

      onNotification('turn/started', {
        turn: { id: 'turn-1' },
      });

      onNotification('turn/completed', {
        turn: { status: 'interrupted' },
      });

      expect(thinkingStates).toEqual([true]);
      expect(emitted).not.toContainEqual({ type: 'as:compact-start' });

      onNotification('item/started', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      expect(emitted).toContainEqual({ type: 'as:compact-start' });

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      const resumedTurnRequest = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter(
          (msg): msg is { id: number; method: string } => !!msg && msg.method === 'turn/start',
        )[1];
      expect(resumedTurnRequest).toBeDefined();

      transport.processLine(
        JSON.stringify({ jsonrpc: '2.0', id: resumedTurnRequest.id, result: {} }),
      );
      onNotification('turn/started', {
        turn: { id: 'turn-2' },
      });
      onNotification('turn/completed', {
        turn: { status: 'completed' },
      });

      expect(thinkingStates).toEqual([true, true, false]);
    });

    it('replays the interrupted prompt once a Codex-initiated compaction completes', async () => {
      const { adapter, transport, written, onNotification, emitted } = setupAdapter();

      (adapter as any).threadId = 'thread-1';

      const firstTurnPromise = (adapter as any).startTurn('Continue working');
      const firstTurnRequest = JSON.parse(written[0].trimEnd());
      transport.processLine(
        JSON.stringify({ jsonrpc: '2.0', id: firstTurnRequest.id, result: {} }),
      );
      await firstTurnPromise;

      onNotification('turn/completed', {
        turn: { status: 'interrupted' },
      });

      onNotification('item/started', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      const turnStartRequests = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter(
          (msg): msg is { method: string; params: { input: Array<{ text: string }> } } =>
            !!msg && msg.method === 'turn/start',
        );

      expect(turnStartRequests).toHaveLength(2);
      expect(turnStartRequests[1].params.input[0].text).toBe('Continue working');
      expect(emitted).toContainEqual({ type: 'as:compact-start' });
      expect(emitted).toContainEqual({
        type: 'as:info',
        message: 'Context compacted. Resuming response…',
      });
    });

    it('replays the interrupted prompt when Codex finishes compaction before reporting turn interruption', async () => {
      const { adapter, transport, written, onNotification } = setupAdapter();
      const thinkingStates: boolean[] = [];

      adapter.onThinkingChange((thinking) => thinkingStates.push(thinking));
      (adapter as any).threadId = 'thread-1';

      const firstTurnPromise = (adapter as any).startTurn('Continue working');
      const firstTurnRequest = JSON.parse(written[0].trimEnd());
      transport.processLine(
        JSON.stringify({ jsonrpc: '2.0', id: firstTurnRequest.id, result: {} }),
      );
      await firstTurnPromise;

      onNotification('turn/started', {
        turn: { id: 'turn-1' },
      });

      onNotification('item/started', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });
      onNotification('turn/completed', {
        turn: { status: 'interrupted' },
      });

      const resumedTurnRequest = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter(
          (msg): msg is { id: number; method: string } => !!msg && msg.method === 'turn/start',
        )[1];
      expect(resumedTurnRequest).toBeDefined();
      expect(thinkingStates).toEqual([true]);

      transport.processLine(
        JSON.stringify({ jsonrpc: '2.0', id: resumedTurnRequest.id, result: {} }),
      );
      onNotification('turn/started', {
        turn: { id: 'turn-2' },
      });
      onNotification('turn/completed', {
        turn: { status: 'completed' },
      });

      expect(thinkingStates).toEqual([true, true, false]);
    });

    it('does not replay the interrupted prompt twice when both compaction item notifications arrive', async () => {
      const { adapter, transport, written, onNotification } = setupAdapter();

      (adapter as any).threadId = 'thread-1';

      const firstTurnPromise = (adapter as any).startTurn('Continue working');
      const firstTurnRequest = JSON.parse(written[0].trimEnd());
      transport.processLine(
        JSON.stringify({ jsonrpc: '2.0', id: firstTurnRequest.id, result: {} }),
      );
      await firstTurnPromise;

      onNotification('turn/completed', {
        turn: { status: 'interrupted' },
      });

      onNotification('item/started', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      let turnStartRequests = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter((msg) => !!msg && msg.method === 'turn/start');

      expect(turnStartRequests).toHaveLength(1);

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      turnStartRequests = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter((msg) => !!msg && msg.method === 'turn/start');

      expect(turnStartRequests).toHaveLength(2);
    });

    it('waits for Codex compaction completion before replaying the interrupted prompt', async () => {
      const { adapter, transport, written, onNotification, emitted } = setupAdapter();

      (adapter as any).threadId = 'thread-1';

      const firstTurnPromise = (adapter as any).startTurn('Continue working');
      const firstTurnRequest = JSON.parse(written[0].trimEnd());
      transport.processLine(
        JSON.stringify({ jsonrpc: '2.0', id: firstTurnRequest.id, result: {} }),
      );
      await firstTurnPromise;

      onNotification('turn/completed', {
        turn: { status: 'interrupted' },
      });

      onNotification('item/started', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      let turnStartRequests = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter(
          (msg): msg is { method: string; params: { input: Array<{ text: string }> } } =>
            !!msg && msg.method === 'turn/start',
        );

      expect(turnStartRequests).toHaveLength(1);
      expect(emitted).not.toContainEqual({
        type: 'as:info',
        message: 'Context compacted. Resuming response…',
      });

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      turnStartRequests = written
        .map((line) => {
          try {
            return JSON.parse(line.trimEnd());
          } catch {
            return null;
          }
        })
        .filter(
          (msg): msg is { method: string; params: { input: Array<{ text: string }> } } =>
            !!msg && msg.method === 'turn/start',
        );

      expect(turnStartRequests).toHaveLength(2);
      expect(turnStartRequests[1].params.input[0].text).toBe('Continue working');
      expect(emitted).toContainEqual({
        type: 'as:info',
        message: 'Context compacted. Resuming response…',
      });
    });

    it('falls back to stopped thinking if no compaction signal arrives after an interrupted turn', () => {
      vi.useFakeTimers();
      const { adapter, transport, written, onNotification } = setupAdapter();
      const thinkingStates: boolean[] = [];

      adapter.onThinkingChange((thinking) => thinkingStates.push(thinking));
      (adapter as any).threadId = 'thread-1';

      const firstTurnPromise = (adapter as any).startTurn('Continue working');
      const firstTurnRequest = JSON.parse(written[0].trimEnd());
      transport.processLine(
        JSON.stringify({ jsonrpc: '2.0', id: firstTurnRequest.id, result: {} }),
      );

      return firstTurnPromise.then(() => {
        onNotification('turn/started', {
          turn: { id: 'turn-1' },
        });
        onNotification('turn/completed', {
          turn: { status: 'interrupted' },
        });

        expect(thinkingStates).toEqual([true]);

        vi.advanceTimersByTime(2_100);

        expect(thinkingStates).toEqual([true, false]);
        vi.useRealTimers();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Compaction watchdog tests
  // -------------------------------------------------------------------------

  describe('compaction watchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears the watchdog when compaction completes normally via item/completed', async () => {
      const { onNotification, adapter, transport, written } = setupAdapter();

      (adapter as any).alive = true;
      (adapter as any).threadId = 'thread-1';

      const compactPromise = (adapter as any).triggerCompaction();

      expect((adapter as any).compacting).toBe(true);

      const compactRequest = written.find((line) => {
        try {
          return JSON.parse(line.trimEnd()).method === 'thread/compact/start';
        } catch {
          return false;
        }
      });
      expect(compactRequest).toBeDefined();
      const req = JSON.parse(compactRequest!.trimEnd());
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }));
      await compactPromise;

      expect((adapter as any).compactionWatchdog).not.toBeNull();

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-1' },
      });

      expect((adapter as any).compacting).toBe(false);
      expect((adapter as any).compactionWatchdog).toBeNull();

      vi.advanceTimersByTime(65_000);

      expect((adapter as any).compacting).toBe(false);
    });

    it('keeps the watchdog running for a Codex-initiated compaction until item/completed', () => {
      const { onNotification, adapter } = setupAdapter();

      (adapter as any).threadId = 'thread-1';

      onNotification('item/started', {
        item: { type: 'contextCompaction', id: 'compact-2' },
      });

      expect((adapter as any).compacting).toBe(true);
      expect((adapter as any).compactionWatchdog).not.toBeNull();

      onNotification('item/completed', {
        item: { type: 'contextCompaction', id: 'compact-2' },
      });

      expect((adapter as any).compacting).toBe(false);
      expect((adapter as any).compactionWatchdog).toBeNull();
    });

    it('fires the watchdog after 60s when compaction stalls', async () => {
      const { adapter, transport, written } = setupAdapter();

      (adapter as any).alive = true;
      (adapter as any).threadId = 'thread-1';

      const compactPromise = (adapter as any).triggerCompaction();

      const compactRequest = written.find((line) => {
        try {
          return JSON.parse(line.trimEnd()).method === 'thread/compact/start';
        } catch {
          return false;
        }
      });
      expect(compactRequest).toBeDefined();
      const req = JSON.parse(compactRequest!.trimEnd());
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }));
      await compactPromise;

      expect((adapter as any).compacting).toBe(true);
      expect((adapter as any).compactionWatchdog).not.toBeNull();

      vi.advanceTimersByTime(59_000);
      expect((adapter as any).compacting).toBe(true);

      vi.advanceTimersByTime(2_000);
      expect((adapter as any).compacting).toBe(false);

      expect((adapter as any).compactionWatchdog).toBeNull();
    });

    it('resets compacting immediately when the compaction RPC fails', async () => {
      const { adapter, transport, written } = setupAdapter();

      (adapter as any).alive = true;
      (adapter as any).threadId = 'thread-1';

      // Directly call triggerCompaction to control the RPC response precisely.
      const compactPromise = (adapter as any).triggerCompaction();

      // Parse the RPC call for thread/compact/start
      const compactRequest = written.find((line) => {
        try {
          return JSON.parse(line.trimEnd()).method === 'thread/compact/start';
        } catch {
          return false;
        }
      });
      expect(compactRequest).toBeDefined();
      const req = JSON.parse(compactRequest!.trimEnd());

      // Simulate an RPC error response
      transport.processLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: 'Internal error during compaction' },
        }),
      );

      await compactPromise;

      // compacting must be reset to false — not stuck
      expect((adapter as any).compacting).toBe(false);

      // No watchdog should remain active
      expect((adapter as any).compactionWatchdog).toBeNull();
    });

    it('does not start a watchdog when the RPC fails immediately', async () => {
      const { adapter, transport, written } = setupAdapter();

      (adapter as any).alive = true;
      (adapter as any).threadId = 'thread-1';

      const compactPromise = (adapter as any).triggerCompaction();

      const compactRequest = written.find((line) => {
        try {
          return JSON.parse(line.trimEnd()).method === 'thread/compact/start';
        } catch {
          return false;
        }
      });
      const req = JSON.parse(compactRequest!.trimEnd());

      transport.processLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32600, message: 'Bad request' },
        }),
      );

      await compactPromise;

      // Advance well past watchdog timeout — nothing should change
      vi.advanceTimersByTime(120_000);

      expect((adapter as any).compacting).toBe(false);
    });

    it('clears a pending watchdog when the process exits', () => {
      const { onNotification, adapter } = setupAdapter();

      (adapter as any).alive = true;
      (adapter as any).threadId = 'thread-1';

      onNotification('item/started', {
        item: { type: 'contextCompaction', id: 'compact-3' },
      });

      expect((adapter as any).compactionWatchdog).not.toBeNull();

      (adapter as any).alive = false;
      (adapter as any).clearCompactionWatchdog();

      expect((adapter as any).compactionWatchdog).toBeNull();
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
