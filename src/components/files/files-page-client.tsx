'use client';

import Link from 'next/link';
import { AlertTriangle, FolderX, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FilesHeader } from './files-header';
import { FilesImageStrip } from './files-image-strip';
import { FilesTable } from './files-table';
import { FilesRootsPicker } from './files-roots-picker';
import type { FileViewerResult } from '@/lib/services/file-viewer-service';

export type FilesInitialPayload =
  | {
      kind: 'ok';
      data: FileViewerResult;
      requestedDir: string | null;
    }
  | {
      kind: 'error';
      statusCode: number;
      code: string;
      message: string;
      requestedDir: string | null;
      allowedRoots: string[];
    };

interface FilesPageClientProps {
  initial: FilesInitialPayload;
}

export function FilesPageClient({ initial }: FilesPageClientProps) {
  return (
    <div className="relative flex flex-col gap-7">
      {/* Atmospheric violet glow — anchored at the top, mirrors sidebar treatment */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-6 h-64"
        style={{
          background:
            'radial-gradient(ellipse 130% 80% at 0% 0%, oklch(0.7 0.18 280 / 0.07) 0%, transparent 70%)',
        }}
      />

      {initial.kind === 'error' ? (
        <FilesErrorState payload={initial} />
      ) : initial.data.dir === null ? (
        <FilesRootsPicker roots={initial.data.allowedRoots} />
      ) : (
        <FilesDirectoryView data={initial.data} dir={initial.data.dir} />
      )}
    </div>
  );
}

function FilesDirectoryView({ data, dir }: { data: FileViewerResult; dir: string }) {
  const images = data.entries.filter((e) => e.isImage);

  return (
    <>
      <FilesHeader
        dir={dir}
        breadcrumbs={data.breadcrumbs}
        itemCount={data.entries.length}
        imageCount={data.imageCount}
      />

      {images.length > 0 && <FilesImageStrip images={images} />}

      {data.entries.length === 0 ? (
        <EmptyState
          icon={FolderX}
          title="Empty directory"
          description="No files or subdirectories here yet."
          action={
            data.parent ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/files?dir=${encodeURIComponent(data.parent)}`}>Back to parent</Link>
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                <Link href="/files">All roots</Link>
              </Button>
            )
          }
        />
      ) : (
        <FilesTable entries={data.entries} parent={data.parent} />
      )}
    </>
  );
}

function FilesErrorState({
  payload,
}: {
  payload: Extract<FilesInitialPayload, { kind: 'error' }>;
}) {
  const isForbidden = payload.statusCode === 403;
  const isNotFound = payload.statusCode === 404;
  const Icon = isForbidden ? ShieldAlert : isNotFound ? FolderX : AlertTriangle;
  const title = isForbidden
    ? 'Path not allowed'
    : isNotFound
      ? 'Directory not found'
      : 'Could not list directory';

  return (
    <section className="space-y-5">
      <header>
        <h1 className="font-serif italic text-foreground text-3xl sm:text-[2.25rem] leading-[1.05] tracking-[-0.02em]">
          Files
        </h1>
      </header>

      <EmptyState
        icon={Icon}
        title={title}
        description={
          isForbidden
            ? 'This path is outside the configured allowed roots. Pick one of the roots below to continue.'
            : isNotFound
              ? 'The directory does not exist or is not accessible.'
              : payload.message
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/files">Back to roots</Link>
          </Button>
        }
      />

      {payload.requestedDir && (
        <p className="text-center font-mono text-[11px] text-muted-foreground/40 break-all">
          {payload.requestedDir}
        </p>
      )}

      {payload.allowedRoots.length > 0 && isForbidden && (
        <FilesRootsPicker roots={payload.allowedRoots} />
      )}
    </section>
  );
}
