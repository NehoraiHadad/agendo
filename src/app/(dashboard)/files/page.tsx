/* eslint-disable react-refresh/only-export-components */
import { basename } from 'node:path';
import type { Metadata } from 'next';
import { type FileViewerResult, listDirectory } from '@/lib/services/file-viewer-service';
import { isAppError } from '@/lib/errors';
import { FilesPageClient, type FilesInitialPayload } from '@/components/files/files-page-client';

export const dynamic = 'force-dynamic';

interface FilesPageProps {
  searchParams: Promise<{ dir?: string | string[] }>;
}

export async function generateMetadata({ searchParams }: FilesPageProps): Promise<Metadata> {
  const sp = await searchParams;
  const dir = typeof sp.dir === 'string' ? sp.dir : undefined;
  return {
    title: dir ? `${basename(dir)} — Files — agenDo` : 'Files — agenDo',
  };
}

export default async function FilesPage({ searchParams }: FilesPageProps) {
  const sp = await searchParams;
  const dir = typeof sp.dir === 'string' ? sp.dir : undefined;

  let initial: FilesInitialPayload;
  try {
    const data = await listDirectory(dir);
    initial = { kind: 'ok', data, requestedDir: dir ?? null };
  } catch (err: unknown) {
    if (isAppError(err)) {
      // Surface 403/404/422 to the client without throwing — the page renders
      // a focused error state with a way to recover (e.g., back to roots).
      const allowedRoots = (await listDirectory().catch(() => null))?.allowedRoots ?? [];
      initial = {
        kind: 'error',
        statusCode: err.statusCode,
        code: err.code,
        message: err.message,
        requestedDir: dir ?? null,
        allowedRoots,
      };
    } else {
      throw err;
    }
  }

  return <FilesPageClient initial={initial} />;
}

// Re-export the type so the client file can import without circular ref.
export type { FileViewerResult };
