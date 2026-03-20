import { accessSync, constants, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { AttachmentRef, inferAttachmentKind } from '@/lib/attachments';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { resolveSessionRuntimeContext } from '@/lib/services/session-runtime-context';

const log = createLogger('session-attachments');

interface IncomingAttachment {
  name: string;
  mimeType?: string | null;
  data: Buffer;
}

const DEFAULT_FILENAME = 'attachment';

function sanitizeAttachmentName(name: string): string {
  const trimmed = basename(name).trim();
  const safe = trimmed.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ');
  return safe || DEFAULT_FILENAME;
}

function ensureWritableDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
  return dir;
}

function resolveAttachmentDir(cwd: string, sessionId: string): string {
  const workspaceDir = join(cwd, '.agendo', 'attachments', sessionId);
  try {
    return ensureWritableDir(workspaceDir);
  } catch (err) {
    const fallbackDir = join(config.LOG_DIR, 'attachments', sessionId);
    log.warn({ err, workspaceDir, fallbackDir, sessionId }, 'Falling back to LOG_DIR attachments');
    return ensureWritableDir(fallbackDir);
  }
}

export async function storeMessageAttachments(
  sessionId: string,
  incoming: IncomingAttachment[],
): Promise<AttachmentRef[]> {
  if (incoming.length === 0) return [];
  const { cwd } = await resolveSessionRuntimeContext(sessionId);
  const dir = resolveAttachmentDir(cwd, sessionId);

  return incoming.map((file) => {
    const id = randomUUID();
    const safeName = sanitizeAttachmentName(file.name);
    const filePath = join(dir, `${id}-${safeName}`);
    writeFileSync(filePath, file.data);
    const mimeType = (file.mimeType ?? 'application/octet-stream').toLowerCase();
    return {
      id,
      name: safeName,
      path: filePath,
      mimeType,
      size: file.data.byteLength,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      kind: inferAttachmentKind(mimeType, safeName),
    };
  });
}

function pendingMetaPath(sessionId: string): string {
  const dir = join(config.LOG_DIR, 'attachments', sessionId);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'resume-pending.json');
}

export function writePendingResumeAttachments(
  sessionId: string,
  attachments: AttachmentRef[],
): void {
  writeFileSync(pendingMetaPath(sessionId), JSON.stringify({ attachments }, null, 2));
}

export function readPendingResumeAttachments(sessionId: string): AttachmentRef[] {
  const metaPath = pendingMetaPath(sessionId);
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf-8')) as
      | { attachments?: AttachmentRef[] }
      | { path?: string; mimeType?: string };
    try {
      unlinkSync(metaPath);
    } catch {
      /* ignore */
    }

    if ('attachments' in parsed && Array.isArray(parsed.attachments)) {
      return parsed.attachments;
    }

    if ('path' in parsed && typeof parsed.path === 'string') {
      const mimeType = parsed.mimeType ?? 'application/octet-stream';
      const stats = readFileSync(parsed.path);
      return [
        {
          id: randomUUID(),
          name: basename(parsed.path),
          path: parsed.path,
          mimeType,
          size: stats.byteLength,
          sha256: createHash('sha256').update(stats).digest('hex'),
          kind: inferAttachmentKind(mimeType, parsed.path),
        },
      ];
    }
  } catch {
    return [];
  }

  return [];
}
