'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { FileViewerEntry } from '@/lib/services/file-viewer-service';

function fileUrl(absolutePath: string): string {
  return `/api/dev/files?path=${encodeURIComponent(absolutePath)}`;
}

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

interface FilesImageStripProps {
  images: FileViewerEntry[];
}

export function FilesImageStrip({ images }: FilesImageStripProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const close = useCallback(() => setOpenIdx(null), []);
  const next = useCallback(
    () => setOpenIdx((i) => (i === null ? null : (i + 1) % images.length)),
    [images.length],
  );
  const prev = useCallback(
    () => setOpenIdx((i) => (i === null ? null : (i - 1 + images.length) % images.length)),
    [images.length],
  );

  useEffect(() => {
    if (openIdx === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openIdx, prev, next]);

  if (images.length === 0) return null;

  const current = openIdx !== null ? images[openIdx] : null;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-400/80">
          Images
        </h2>
        <span className="h-px flex-1 bg-gradient-to-r from-amber-400/20 to-transparent" />
        <span className="text-[10px] font-mono tabular-nums text-muted-foreground/40">
          {images.length}
        </span>
      </div>

      <div
        className={cn(
          'flex gap-3 overflow-x-auto pb-3 -mx-1 px-1',
          'snap-x snap-mandatory scroll-px-1',
          'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10',
        )}
      >
        {images.map((img, i) => (
          <button
            key={img.path}
            type="button"
            onClick={() => setOpenIdx(i)}
            className={cn(
              'group relative shrink-0 snap-start overflow-hidden rounded-xl border border-white/[0.07] bg-card/40',
              'w-[180px] sm:w-[200px] aspect-[4/3]',
              'hover:border-primary/40 hover:-translate-y-px transition-all duration-200',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
            )}
            aria-label={`Open ${img.name}`}
          >
            {/* Raw <img> intentional: /api/dev/files paths have unknown dimensions and would
                require remotePatterns for next/image. The route serves correct MIME types. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileUrl(img.path)}
              alt={img.name}
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            />
            <div
              className={cn(
                'absolute inset-x-0 bottom-0 px-3 py-2 text-left text-[11px]',
                'bg-gradient-to-t from-black/85 via-black/55 to-transparent',
                'translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all',
              )}
            >
              <div className="truncate font-medium text-white/95">{img.name}</div>
              <div className="font-mono tabular-nums text-white/55">{formatBytes(img.size)}</div>
            </div>
          </button>
        ))}
      </div>

      <Dialog open={openIdx !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent
          showCloseButton={false}
          className="bg-transparent border-0 shadow-none p-0 w-[96vw] max-w-[1400px] sm:max-w-[1400px] h-[92dvh] max-h-[92dvh] flex items-center justify-center"
        >
          <DialogTitle className="sr-only">{current?.name ?? 'Image preview'}</DialogTitle>

          {current && (
            <>
              {images.length > 1 && (
                <button
                  type="button"
                  onClick={prev}
                  aria-label="Previous image"
                  className="absolute left-2 sm:left-6 top-1/2 -translate-y-1/2 z-10 inline-flex size-12 items-center justify-center rounded-full bg-black/40 text-white/80 hover:bg-black/60 hover:text-white transition-colors"
                >
                  <ChevronLeft className="size-6" />
                </button>
              )}

              {images.length > 1 && (
                <button
                  type="button"
                  onClick={next}
                  aria-label="Next image"
                  className="absolute right-2 sm:right-6 top-1/2 -translate-y-1/2 z-10 inline-flex size-12 items-center justify-center rounded-full bg-black/40 text-white/80 hover:bg-black/60 hover:text-white transition-colors"
                >
                  <ChevronRight className="size-6" />
                </button>
              )}

              <button
                type="button"
                onClick={close}
                aria-label="Close preview"
                className="absolute right-3 top-3 z-10 inline-flex size-9 items-center justify-center rounded-full bg-black/40 text-white/80 hover:bg-black/60 hover:text-white transition-colors"
              >
                <X className="size-5" />
              </button>

              <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                {/* Raw <img>: lightbox preview at native size; next/image not applicable. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={fileUrl(current.path)}
                  alt={current.name}
                  className="max-h-[78dvh] max-w-full rounded-lg object-contain shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)]"
                />
                <div className="flex items-center gap-3 rounded-full bg-black/45 px-4 py-2 text-[12px] text-white/85 backdrop-blur">
                  <span className="truncate max-w-[60vw]">{current.name}</span>
                  <span className="font-mono tabular-nums text-white/50">
                    {formatBytes(current.size)}
                  </span>
                  <span className="text-white/30">·</span>
                  <span className="font-mono tabular-nums text-white/50">
                    {openIdx !== null ? `${openIdx + 1} / ${images.length}` : ''}
                  </span>
                  <a
                    href={fileUrl(current.path)}
                    download={current.name}
                    className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/90 hover:bg-white/20 transition-colors"
                    aria-label="Download image"
                  >
                    <Download className="size-3" />
                    Download
                  </a>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
