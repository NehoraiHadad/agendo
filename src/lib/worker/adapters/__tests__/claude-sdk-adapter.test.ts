import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { ClaudeSdkAdapter } from '@/lib/worker/adapters/claude-sdk-adapter';
import type { AgendoEventPayload } from '@/lib/realtime/events';

type TestableClaudeSdkAdapter = {
  eventCallbacks: Array<(payloads: AgendoEventPayload[]) => void>;
  processJsonlChunk(chunk: string): void;
};

function createTestAdapter(): TestableClaudeSdkAdapter {
  return new ClaudeSdkAdapter() as unknown as TestableClaudeSdkAdapter;
}

describe('ClaudeSdkAdapter JSONL dequeue parsing', () => {
  it('emits user:message-dequeued for dequeue queue-operation records', () => {
    const adapter = createTestAdapter();
    const received: AgendoEventPayload[][] = [];
    adapter.eventCallbacks = [(payloads: AgendoEventPayload[]) => received.push(payloads)];

    adapter.processJsonlChunk(
      `${JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-23T19:00:00.000Z',
        sessionId: 'sess-1',
      })}\n`,
    );

    expect(received).toEqual([[{ type: 'user:message-dequeued' }]]);
  });

  it('buffers partial JSONL lines until a newline arrives', () => {
    const adapter = createTestAdapter();
    const received: AgendoEventPayload[][] = [];
    adapter.eventCallbacks = [(payloads: AgendoEventPayload[]) => received.push(payloads)];

    adapter.processJsonlChunk(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-23T19:00:00.000Z',
        sessionId: 'sess-1',
      }),
    );
    expect(received).toEqual([]);

    adapter.processJsonlChunk('\n');
    expect(received).toEqual([[{ type: 'user:message-dequeued' }]]);
  });

  it('ignores non-dequeue JSONL records', () => {
    const adapter = createTestAdapter();
    const received: AgendoEventPayload[][] = [];
    adapter.eventCallbacks = [(payloads: AgendoEventPayload[]) => received.push(payloads)];

    adapter.processJsonlChunk(
      [
        JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          timestamp: '2026-03-23T19:00:00.000Z',
          sessionId: 'sess-1',
          content: 'queued',
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'asst-1',
          parentUuid: null,
          isSidechain: false,
          timestamp: '2026-03-23T19:00:00.100Z',
          requestId: 'req-1',
          cwd: '/tmp',
          gitBranch: 'main',
          message: { role: 'assistant', content: [], model: 'x', usage: {}, stop_reason: 'end' },
        }),
      ].join('\n') + '\n',
    );

    expect(received).toEqual([]);
  });
});
