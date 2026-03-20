import { extname } from 'node:path';

export type AttachmentKind = 'image' | 'file';

export interface AttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
}

export interface AttachmentRef extends AttachmentMeta {
  path: string;
  sha256: string;
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.tif',
  '.tiff',
  '.ico',
  '.heic',
  '.heif',
  '.avif',
]);

const NATIVE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function inferAttachmentKind(mimeType?: string | null, name?: string): AttachmentKind {
  if (mimeType?.toLowerCase().startsWith('image/')) return 'image';
  const extension = extname(name ?? '').toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) ? 'image' : 'file';
}

export function isImageAttachment(
  attachment: Pick<AttachmentMeta, 'kind' | 'mimeType' | 'name'>,
): boolean {
  return (
    attachment.kind === 'image' ||
    inferAttachmentKind(attachment.mimeType, attachment.name) === 'image'
  );
}

export function supportsNativeImageAttachment(
  attachment: Pick<AttachmentMeta, 'kind' | 'mimeType' | 'name'>,
): boolean {
  return (
    isImageAttachment(attachment) && NATIVE_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase())
  );
}

export function toAttachmentMeta(attachment: AttachmentRef | AttachmentMeta): AttachmentMeta {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
  };
}

export function buildAttachmentManifest(attachments: AttachmentRef[]): string {
  if (attachments.length === 0) return '';
  return [
    'Attached files available in the workspace:',
    ...attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes) at ${attachment.path}`,
    ),
    'Read them from disk if you need to inspect their full contents.',
  ].join('\n');
}

export function appendAttachmentManifest(message: string, attachments: AttachmentRef[]): string {
  const manifest = buildAttachmentManifest(attachments);
  if (!manifest) return message;
  const trimmed = message.trim();
  return trimmed ? `${trimmed}\n\n${manifest}` : manifest;
}

export function getNativeImageAttachments(attachments: AttachmentRef[]): AttachmentRef[] {
  return attachments.filter((attachment) => supportsNativeImageAttachment(attachment));
}
