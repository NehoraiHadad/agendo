'use client';

import type { QueuedAttachmentPayload } from '@/components/sessions/session-message-input';

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function attachmentToFile(attachment: QueuedAttachmentPayload): File {
  const sourceBytes = base64ToBytes(attachment.data);
  const normalizedBytes = new Uint8Array(sourceBytes.length);
  normalizedBytes.set(sourceBytes);
  return new File([normalizedBytes], attachment.name, {
    type: attachment.mimeType || 'application/octet-stream',
  });
}

export function buildMessageFormData(
  message: string,
  attachments?: QueuedAttachmentPayload[],
  extra?: { priority?: 'now' | 'next' | 'later'; clientId?: string },
): FormData {
  const formData = new FormData();
  formData.set('message', message);
  if (extra?.priority) formData.set('priority', extra.priority);
  if (extra?.clientId) formData.set('clientId', extra.clientId);
  for (const attachment of attachments ?? []) {
    formData.append('attachments', attachmentToFile(attachment));
  }
  return formData;
}
