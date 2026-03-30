import { NextRequest } from 'next/server';
import { stat, readFile } from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';

/** Allowed root directories for file serving */
const ALLOWED_ROOTS = ['/home/ubuntu/projects', '/tmp'];

const MIME_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'text/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function isPathAllowed(resolvedPath: string): boolean {
  return ALLOWED_ROOTS.some((root) => resolvedPath.startsWith(root + '/') || resolvedPath === root);
}

/**
 * GET /api/dev/files?path=...
 * Serves a filesystem file with correct Content-Type headers.
 * Path traversal prevention via allowed roots check on resolved path.
 */
export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get('path');

  if (!filePath) {
    return new Response(JSON.stringify({ error: 'Missing ?path= parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Resolve to absolute path, preventing traversal
  const resolved = path.resolve(filePath);

  if (!isPathAllowed(resolved)) {
    return new Response(JSON.stringify({ error: 'Path not allowed', allowed: ALLOWED_ROOTS }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const fileStat = await stat(resolved);

    if (!fileStat.isFile()) {
      return new Response(JSON.stringify({ error: 'Not a file' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const content = await readFile(resolved);
    const mimeType = getMimeType(resolved);

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileStat.size),
        'Cache-Control': 'public, max-age=60',
        'Content-Disposition': 'inline',
      },
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return new Response(JSON.stringify({ error: 'File not found', path: resolved }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (code === 'EACCES') {
      return new Response(JSON.stringify({ error: 'Permission denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
