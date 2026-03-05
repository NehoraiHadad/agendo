import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NdjsonRpcTransport } from '../ndjson-rpc-transport';

describe('NdjsonRpcTransport', () => {
  let written: string[];
  let onServerRequest: ReturnType<typeof vi.fn>;
  let onNotification: ReturnType<typeof vi.fn>;
  let transport: NdjsonRpcTransport;

  beforeEach(() => {
    written = [];
    const fakeStdin = {
      writable: true,
      write: (data: string) => {
        written.push(data);
      },
    };
    onServerRequest = vi.fn();
    onNotification = vi.fn();

    transport = new NdjsonRpcTransport({
      getStdin: () => fakeStdin as unknown as NodeJS.WritableStream,
      onServerRequest,
      onNotification,
    });
  });

  describe('call()', () => {
    it('sends correct JSON-RPC format to stdin', () => {
      // Don't await — just fire the call
      transport.call('thread/start', { threadId: '123' });

      expect(written).toHaveLength(1);
      const sent = JSON.parse(written[0].trimEnd());
      expect(sent).toEqual({
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'thread/start',
        params: { threadId: '123' },
      });
    });

    it('resolves when matching response arrives via processLine()', async () => {
      const promise = transport.call('initialize', {});

      // Extract the id from what was written
      const sent = JSON.parse(written[0].trimEnd());
      const id = sent.id;

      // Simulate server response
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));

      const result = await promise;
      expect(result).toEqual({ ok: true });
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();
      const promise = transport.call('slow/method', {}, 500);

      vi.advanceTimersByTime(501);

      await expect(promise).rejects.toThrow('RPC timeout: slow/method');
      vi.useRealTimers();
    });

    it('rejects on JSON-RPC error response', async () => {
      const promise = transport.call('bad/method', {});

      const sent = JSON.parse(written[0].trimEnd());
      transport.processLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: sent.id,
          error: { code: -32600, message: 'Invalid request' },
        }),
      );

      await expect(promise).rejects.toThrow('Invalid request');
    });

    it('rejects when stdin is not writable', async () => {
      const deadTransport = new NdjsonRpcTransport({
        getStdin: () => null,
        onServerRequest: vi.fn(),
        onNotification: vi.fn(),
      });

      await expect(deadTransport.call('any', {})).rejects.toThrow('stdin not writable');
    });
  });

  describe('respond()', () => {
    it('sends correct JSON-RPC response format', () => {
      transport.respond(42, { decision: 'accept' });

      expect(written).toHaveLength(1);
      const sent = JSON.parse(written[0].trimEnd());
      expect(sent).toEqual({
        jsonrpc: '2.0',
        id: 42,
        result: { decision: 'accept' },
      });
    });

    it('does nothing when stdin is not writable', () => {
      const deadTransport = new NdjsonRpcTransport({
        getStdin: () => null,
        onServerRequest: vi.fn(),
        onNotification: vi.fn(),
      });
      // Should not throw
      deadTransport.respond(1, {});
    });
  });

  describe('notify()', () => {
    it('sends notification with no id field', () => {
      transport.notify('event/happened', { data: 'hello' });

      expect(written).toHaveLength(1);
      const sent = JSON.parse(written[0].trimEnd());
      expect(sent).toEqual({
        jsonrpc: '2.0',
        method: 'event/happened',
        params: { data: 'hello' },
      });
      expect(sent).not.toHaveProperty('id');
    });

    it('does nothing when stdin is not writable', () => {
      const deadTransport = new NdjsonRpcTransport({
        getStdin: () => null,
        onServerRequest: vi.fn(),
        onNotification: vi.fn(),
      });
      deadTransport.notify('test', {});
    });
  });

  describe('processLine()', () => {
    it('dispatches server requests to onServerRequest callback', () => {
      transport.processLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'item/commandExecution/requestApproval',
          params: { command: 'rm -rf /' },
        }),
      );

      expect(onServerRequest).toHaveBeenCalledWith(99, 'item/commandExecution/requestApproval', {
        command: 'rm -rf /',
      });
    });

    it('dispatches notifications to onNotification callback', () => {
      transport.processLine(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { turnId: 'abc' },
        }),
      );

      expect(onNotification).toHaveBeenCalledWith('turn/completed', {
        turnId: 'abc',
      });
    });

    it('resolves pending calls on matching response', async () => {
      const promise = transport.call('test/method', {});
      const sent = JSON.parse(written[0].trimEnd());

      transport.processLine(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { value: 42 } }));

      await expect(promise).resolves.toEqual({ value: 42 });
    });

    it('ignores empty lines', () => {
      transport.processLine('');
      transport.processLine('   ');
      expect(onServerRequest).not.toHaveBeenCalled();
      expect(onNotification).not.toHaveBeenCalled();
    });

    it('ignores non-JSON lines', () => {
      transport.processLine('not json at all');
      expect(onServerRequest).not.toHaveBeenCalled();
      expect(onNotification).not.toHaveBeenCalled();
    });

    it('handles notification with missing params', () => {
      transport.processLine(JSON.stringify({ jsonrpc: '2.0', method: 'some/event' }));

      expect(onNotification).toHaveBeenCalledWith('some/event', {});
    });
  });

  describe('rejectAll()', () => {
    it('rejects all pending requests with given reason', async () => {
      vi.useFakeTimers();
      const p1 = transport.call('method/a', {});
      const p2 = transport.call('method/b', {});

      transport.rejectAll('process exited');

      await expect(p1).rejects.toThrow('process exited');
      await expect(p2).rejects.toThrow('process exited');
      vi.useRealTimers();
    });

    it('clears timeouts when rejecting', async () => {
      vi.useFakeTimers();
      const p = transport.call('method/a', {});

      transport.rejectAll('done');

      // Consume the rejection so it doesn't leak
      await expect(p).rejects.toThrow('done');

      // Advancing time should not cause additional rejections
      vi.advanceTimersByTime(60000);
      vi.useRealTimers();
    });
  });
});
