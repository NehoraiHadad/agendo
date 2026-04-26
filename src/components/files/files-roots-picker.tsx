'use client';

import Link from 'next/link';
import { ArrowRight, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FilesRootsPickerProps {
  roots: string[];
}

function rootName(absolute: string): string {
  const parts = absolute.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? absolute;
}

export function FilesRootsPicker({ roots }: FilesRootsPickerProps) {
  return (
    <section className="space-y-6">
      <header>
        <h1
          className={cn(
            'font-serif italic text-foreground text-3xl sm:text-[2.25rem] leading-[1.05] tracking-[-0.02em]',
          )}
        >
          Files
        </h1>
        <p className="mt-2 text-sm text-muted-foreground/65 max-w-md">
          Browse any directory under the configured allowed roots. Pick a root to start.
        </p>
      </header>

      <ul className="grid gap-3 sm:grid-cols-2">
        {roots.map((root, i) => (
          <li
            key={root}
            className="animate-fade-in-up opacity-0"
            style={{ animationDelay: `${i * 60}ms`, animationFillMode: 'forwards' }}
          >
            <Link
              href={`/files?dir=${encodeURIComponent(root)}`}
              className={cn(
                'group relative flex items-center gap-4 rounded-2xl border border-white/[0.06] bg-card/50 p-5 transition-all duration-200',
                'hover:border-primary/40 hover:bg-card hover:-translate-y-px',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
              )}
            >
              <div
                className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/[0.07] text-primary/85"
                style={{ boxShadow: 'inset 0 1px 0 oklch(1 0 0 / 0.06)' }}
              >
                <FolderOpen className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold text-foreground/95">{rootName(root)}</div>
                <code className="block font-mono text-[11px] text-muted-foreground/55 truncate">
                  {root}
                </code>
              </div>
              <ArrowRight className="size-4 text-muted-foreground/40 transition-all group-hover:text-primary/85 group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
