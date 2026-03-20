import { readFileSync } from 'node:fs';
import {
  appendAttachmentManifest,
  getNativeImageAttachments,
  type AttachmentRef,
} from '@/lib/attachments';

export interface NativeImageContent {
  attachment: AttachmentRef;
  data: string;
}

export function buildMessageWithAttachments(
  message: string,
  attachments?: AttachmentRef[],
): string {
  return appendAttachmentManifest(message, attachments ?? []);
}

export function readNativeImageContents(attachments?: AttachmentRef[]): NativeImageContent[] {
  if (!attachments || attachments.length === 0) return [];
  const nativeImages = getNativeImageAttachments(attachments);
  const contents: NativeImageContent[] = [];
  for (const attachment of nativeImages) {
    try {
      contents.push({
        attachment,
        data: readFileSync(attachment.path).toString('base64'),
      });
    } catch {
      // Ignore unreadable files; the path still appears in the text manifest.
    }
  }
  return contents;
}
