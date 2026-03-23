import { describe, expect, it } from 'vitest';
import type { AgendoEvent } from '@/lib/realtime/events';
import {
  enqueueQueuedMessage,
  parsePersistedQueuedMessages,
  patchQueuedMessage,
  removeQueuedMessage,
  resolveQueuedMessages,
  type QueuedMessage,
} from '../session-chat-queue';

const baseEvent = { sessionId: 'session-1', ts: 0 };

function createQueuedMessage(id: string, text = id): QueuedMessage {
  return { id, clientId: id, text, isSending: true };
}

describe('parsePersistedQueuedMessages', () => {
  it('migrates the legacy single-message storage shape into an array', () => {
    expect(
      parsePersistedQueuedMessages(
        JSON.stringify({
          text: 'queued',
          isSending: false,
          clientId: 'legacy-1',
        }),
      ),
    ).toEqual([{ id: 'legacy-1', text: 'queued', isSending: false, clientId: 'legacy-1' }]);
  });

  it('loads the multi-message storage shape and skips invalid entries', () => {
    expect(
      parsePersistedQueuedMessages(
        JSON.stringify([
          { id: 'first', clientId: 'first', text: 'one', isSending: true },
          { nope: true },
          { id: 'second', clientId: 'second', text: 'two', isSending: false },
        ]),
      ),
    ).toEqual([
      { id: 'first', clientId: 'first', text: 'one', isSending: true },
      { id: 'second', clientId: 'second', text: 'two', isSending: false },
    ]);
  });
});

describe('queued message helpers', () => {
  it('appends queued messages in FIFO order', () => {
    expect(
      enqueueQueuedMessage(
        enqueueQueuedMessage([], createQueuedMessage('first')),
        createQueuedMessage('second'),
      ).map((message) => message.id),
    ).toEqual(['first', 'second']);
  });

  it('patches only the targeted queued message', () => {
    expect(
      patchQueuedMessage([createQueuedMessage('first'), createQueuedMessage('second')], 'second', {
        isSending: false,
      }),
    ).toEqual([
      createQueuedMessage('first'),
      { id: 'second', clientId: 'second', text: 'second', isSending: false },
    ]);
  });

  it('removes only the intended queued message', () => {
    expect(
      removeQueuedMessage(
        [createQueuedMessage('first'), createQueuedMessage('second')],
        'first',
      ).map((message) => message.id),
    ).toEqual(['second']);
  });

  it('clears only the queued items confirmed by delivery or cancellation events', () => {
    const queue = [
      createQueuedMessage('first'),
      createQueuedMessage('second'),
      createQueuedMessage('third'),
    ];
    const userMessages: AgendoEvent[] = [
      { ...baseEvent, id: 1, type: 'user:message', text: 'first', clientId: 'first' },
    ];
    const cancelledMessages: AgendoEvent[] = [
      { ...baseEvent, id: 2, type: 'user:message-cancelled', clientId: 'third' },
    ];

    expect(resolveQueuedMessages(queue, userMessages, cancelledMessages)).toEqual([
      createQueuedMessage('second'),
    ]);
  });
});
