import type { QueuedAttachmentPayload } from '@/components/sessions/session-message-input';
import type { AgendoEvent } from '@/lib/realtime/events';

export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: QueuedAttachmentPayload[];
  isSending: boolean;
  clientId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toQueuedMessage(value: unknown): QueuedMessage | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  const clientId = typeof value.clientId === 'string' ? value.clientId : undefined;
  const id =
    typeof value.id === 'string' && value.id.length > 0
      ? value.id
      : clientId && clientId.length > 0
        ? clientId
        : null;

  if (!id) return null;

  return {
    id,
    text: value.text,
    attachments: Array.isArray(value.attachments)
      ? (value.attachments as QueuedAttachmentPayload[])
      : undefined,
    isSending: value.isSending === true,
    clientId,
  };
}

export function parsePersistedQueuedMessages(raw: string | null): QueuedMessage[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => {
        const queued = toQueuedMessage(item);
        return queued ? [queued] : [];
      });
    }

    const queued = toQueuedMessage(parsed);
    return queued ? [queued] : [];
  } catch {
    return [];
  }
}

export function enqueueQueuedMessage(
  queue: readonly QueuedMessage[],
  message: QueuedMessage,
): QueuedMessage[] {
  return [...queue, message];
}

export function patchQueuedMessage(
  queue: readonly QueuedMessage[],
  id: string,
  patch: Partial<QueuedMessage>,
): QueuedMessage[] {
  let changed = false;
  const next = queue.map((message) => {
    if (message.id !== id) return message;
    changed = true;
    return { ...message, ...patch };
  });
  return changed ? next : (queue as QueuedMessage[]);
}

export function removeQueuedMessage(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  const next = queue.filter((message) => message.id !== id);
  return next.length === queue.length ? (queue as QueuedMessage[]) : next;
}

export function resolveQueuedMessages(
  queue: readonly QueuedMessage[],
  userMessages: readonly AgendoEvent[],
  cancelledMessages: readonly AgendoEvent[],
): QueuedMessage[] {
  if (queue.length === 0) return [];

  const resolvedClientIds = new Set<string>();
  for (const event of userMessages) {
    if ('clientId' in event && typeof event.clientId === 'string') {
      resolvedClientIds.add(event.clientId);
    }
  }
  for (const event of cancelledMessages) {
    if ('clientId' in event && typeof event.clientId === 'string') {
      resolvedClientIds.add(event.clientId);
    }
  }

  if (resolvedClientIds.size === 0) return queue as QueuedMessage[];

  const next = queue.filter(
    (message) => !message.clientId || !resolvedClientIds.has(message.clientId),
  );
  return next.length === queue.length ? (queue as QueuedMessage[]) : next;
}
