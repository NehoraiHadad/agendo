'use client';

import Link from 'next/link';
import { ArrowUp, Download, FileCode2, FileImage, FileText, FileVideo, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileViewerEntry } from '@/lib/services/file-viewer-service';

const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.py',
  '.rb',
  '.rs',
  '.go',
  '.java',
  '.sh',
  '.toml',
  '.yaml',
  '.yml',
  '.html',
  '.css',
  '.scss',
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function iconFor(entry: FileViewerEntry) {
  if (entry.isDir) return Folder;
  if (entry.isImage) return FileImage;
  if (entry.isVideo) return FileVideo;
  if (CODE_EXTS.has(extOf(entry.name))) return FileCode2;
  return FileText;
}

function formatBytes(n: number): string {
  if (n === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.floor((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
}

function fileUrl(absolutePath: string): string {
  return `/api/dev/files?path=${encodeURIComponent(absolutePath)}`;
}

interface FilesTableProps {
  entries: FileViewerEntry[];
  parent: string | null;
}

export function FilesTable({ entries, parent }: FilesTableProps) {
  const showParent = parent !== null;
  const total = entries.length + (showParent ? 1 : 0);

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/45">
          Contents
        </h2>
        <span className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        <span className="text-[10px] font-mono tabular-nums text-muted-foreground/40">{total}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-card/30">
        <ul role="list" className="divide-y divide-white/[0.04]">
          {showParent && parent && (
            <li>
              <Link
                href={`/files?dir=${encodeURIComponent(parent)}`}
                className={cn(
                  'group relative grid grid-cols-[auto_1fr_70px] sm:grid-cols-[auto_1fr_90px_140px] items-center gap-3 px-4 py-2.5 text-sm transition-colors',
                  'text-muted-foreground/70 hover:text-foreground hover:bg-white/[0.025]',
                )}
              >
                <span className="absolute inset-y-0 left-0 w-0 bg-primary/70 transition-all duration-150 group-hover:w-[2px]" />
                <ArrowUp className="size-4 text-muted-foreground/45" />
                <span className="font-medium">Parent directory</span>
                <span />
                <span className="hidden sm:inline" />
              </Link>
            </li>
          )}

          {entries.map((entry, i) => {
            const Icon = iconFor(entry);
            const linkHref = entry.isDir
              ? `/files?dir=${encodeURIComponent(entry.path)}`
              : fileUrl(entry.path);
            const linkProps = entry.isDir
              ? {}
              : { target: '_blank' as const, rel: 'noopener noreferrer' };

            const RowLink = entry.isDir ? Link : 'a';
            const rowDelay = `${Math.min(i, 30) * 18}ms`;

            return (
              <li key={entry.path}>
                <RowLink
                  href={linkHref}
                  {...linkProps}
                  className={cn(
                    'group relative grid grid-cols-[auto_1fr_70px] sm:grid-cols-[auto_1fr_90px_140px] items-center gap-3 px-4 py-2.5 text-sm transition-colors',
                    'text-foreground/85 hover:bg-white/[0.025]',
                    'animate-fade-in-up opacity-0',
                  )}
                  style={{
                    animationDelay: rowDelay,
                    animationFillMode: 'forwards',
                  }}
                >
                  <span className="absolute inset-y-0 left-0 w-0 bg-primary/80 transition-all duration-150 group-hover:w-[2px]" />
                  <Icon
                    className={cn(
                      'size-4 shrink-0',
                      entry.isDir
                        ? 'text-primary/75'
                        : entry.isImage
                          ? 'text-amber-400/80'
                          : entry.isVideo
                            ? 'text-rose-400/75'
                            : 'text-muted-foreground/55',
                    )}
                  />
                  <span className="min-w-0 truncate font-medium group-hover:text-foreground">
                    {entry.name}
                  </span>
                  <span className="text-right font-mono text-[12px] tabular-nums text-muted-foreground/60">
                    {entry.isDir ? '—' : formatBytes(entry.size)}
                  </span>
                  <span
                    className="hidden sm:inline text-right font-mono text-[12px] tabular-nums text-muted-foreground/45"
                    title={formatAbsolute(entry.modified)}
                  >
                    {formatRelative(entry.modified)}
                  </span>
                  {!entry.isDir && (
                    <Download
                      className={cn(
                        'pointer-events-none absolute right-3 size-3.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/40',
                        'sm:hidden',
                      )}
                    />
                  )}
                </RowLink>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
