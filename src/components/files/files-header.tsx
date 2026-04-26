'use client';

import Link from 'next/link';
import { ChevronRight, FolderOpen, Home } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';
import type { FileViewerBreadcrumb } from '@/lib/services/file-viewer-service';

function hrefFor(dir: string | null): string {
  return dir ? `/files?dir=${encodeURIComponent(dir)}` : '/files';
}

interface FilesHeaderProps {
  dir: string;
  breadcrumbs: FileViewerBreadcrumb[];
  itemCount: number;
  imageCount: number;
}

export function FilesHeader({ dir, breadcrumbs, itemCount, imageCount }: FilesHeaderProps) {
  const displayName = breadcrumbs[breadcrumbs.length - 1]?.label ?? dir;
  // Show all breadcrumbs except the last (which we render as the hero name).
  const trail = breadcrumbs.slice(0, -1);

  return (
    <header className="relative">
      {/* Breadcrumb chips */}
      <nav
        aria-label="Breadcrumb"
        className="flex flex-wrap items-center gap-1 text-[12px] text-muted-foreground/60"
      >
        <Link
          href="/files"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:text-foreground/85 hover:bg-white/[0.04] transition-colors"
          aria-label="All allowed roots"
        >
          <Home className="size-3" />
          <span>Files</span>
        </Link>
        {trail.map((crumb) => (
          <span key={crumb.path} className="inline-flex items-center gap-1">
            <ChevronRight className="size-3 text-muted-foreground/30" />
            <Link
              href={hrefFor(crumb.path)}
              className="rounded-md px-1.5 py-1 hover:text-foreground/85 hover:bg-white/[0.04] transition-colors"
            >
              {crumb.label}
            </Link>
          </span>
        ))}
        {breadcrumbs.length > 0 && <ChevronRight className="size-3 text-muted-foreground/30" />}
        <span className="px-1.5 py-1 text-foreground/85 font-medium">{displayName}</span>
      </nav>

      {/* Hero block */}
      <div className="mt-5 flex items-start gap-4">
        <div
          className={cn(
            'flex size-12 shrink-0 items-center justify-center rounded-xl',
            'border border-primary/20 bg-primary/[0.07]',
          )}
          style={{ boxShadow: 'inset 0 1px 0 oklch(1 0 0 / 0.06)' }}
        >
          <FolderOpen className="size-5 text-primary/85" />
        </div>
        <div className="min-w-0 flex-1">
          <h1
            className={cn(
              'font-serif italic text-foreground text-3xl sm:text-[2.25rem] leading-[1.05] tracking-[-0.02em] truncate',
            )}
            title={displayName}
          >
            {displayName}
          </h1>
          <div className="mt-2 flex items-center gap-1.5 group">
            <code
              className="font-mono text-[11px] text-muted-foreground/55 truncate min-w-0"
              title={dir}
            >
              {dir}
            </code>
            <CopyButton
              text={dir}
              className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity sm:min-h-0 sm:min-w-0 size-5"
            />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground/60 tabular-nums">
            <span className="text-foreground/70 font-medium">{itemCount}</span>{' '}
            {itemCount === 1 ? 'item' : 'items'}
            {imageCount > 0 && (
              <>
                {' · '}
                <span className="text-amber-400/80 font-medium">{imageCount}</span>{' '}
                {imageCount === 1 ? 'image' : 'images'}
              </>
            )}
          </p>
        </div>
      </div>
    </header>
  );
}
