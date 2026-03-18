'use client';

import { useState, useMemo, useSyncExternalStore } from 'react';
import { ArrowUpCircle, RefreshCw, Terminal, Zap } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverHeader,
  PopoverTitle,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useVersionCheck } from '@/hooks/use-version-check';
import { UpgradeDialog } from '@/components/upgrade-dialog';
import { cn } from '@/lib/utils';

/**
 * Version badge for the sidebar footer.
 * Shows current version with an update indicator when a newer version is available.
 */
export function VersionBadge() {
  const { currentVersion, latestVersion, updateAvailable, checkedAt, isLoading, refresh } =
    useVersionCheck();
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // Client-only flag — avoids Radix Popover hydration mismatch (aria-controls IDs
  // from useId() differ between SSR and client when the component tree varies).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Format on client only to avoid hydration mismatch (server locale may differ).
  const formattedCheckedAt = useMemo(
    () =>
      checkedAt
        ? new Date(checkedAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : null,
    [checkedAt],
  );

  if (!mounted) {
    // SSR placeholder — matches the visual footprint without Radix Popover
    return (
      <span className="flex items-center gap-2 rounded px-1 py-0.5">
        <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-emerald-400/60" />
        <span className="text-[9px] text-muted-foreground/25 uppercase tracking-widest">
          v{currentVersion} · Online
        </span>
      </span>
    );
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="flex items-center gap-2 group cursor-pointer rounded px-1 py-0.5 hover:bg-white/[0.04] transition-colors"
            aria-label={
              updateAvailable
                ? `Version ${currentVersion} — update available`
                : `Version ${currentVersion}`
            }
          >
            <span className="relative flex items-center">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  updateAvailable
                    ? 'bg-amber-400/80 animate-pulse'
                    : 'bg-emerald-400/60 animate-pulse',
                )}
              />
              {updateAvailable && (
                <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-400/20 animate-ping" />
              )}
            </span>
            <span className="text-[9px] text-muted-foreground/25 uppercase tracking-widest group-hover:text-muted-foreground/40 transition-colors">
              v{currentVersion}
              {updateAvailable ? (
                <span className="text-amber-400/60 ml-1">↑</span>
              ) : (
                <span> · Online</span>
              )}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-72">
          <PopoverHeader>
            <PopoverTitle className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
              Agendo
            </PopoverTitle>
          </PopoverHeader>

          <div className="mt-3 space-y-3">
            {/* Current version */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Current</span>
              <span className="font-mono text-xs">v{currentVersion}</span>
            </div>

            {/* Git SHA */}
            {process.env.NEXT_PUBLIC_GIT_SHA && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Build</span>
                <span className="font-mono text-xs text-muted-foreground/60">
                  {process.env.NEXT_PUBLIC_GIT_SHA}
                </span>
              </div>
            )}

            {/* Update available */}
            {updateAvailable && latestVersion && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  Update available
                </div>
                <div className="text-xs text-muted-foreground">
                  v{currentVersion} → v{latestVersion}
                </div>
                <Button
                  size="sm"
                  className="w-full h-7 text-xs gap-1.5"
                  onClick={() => setUpgradeOpen(true)}
                >
                  <Zap className="h-3 w-3" />
                  Upgrade to v{latestVersion}
                </Button>
              </div>
            )}

            {/* No update */}
            {!updateAvailable && latestVersion && (
              <div className="flex items-center gap-2 text-xs text-emerald-400/70">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
                Up to date
              </div>
            )}

            {/* Last checked + refresh */}
            <div className="flex items-center justify-between border-t border-border/40 pt-2">
              <span className="text-[10px] text-muted-foreground/40">
                {formattedCheckedAt ? `Checked ${formattedCheckedAt}` : 'Not checked yet'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => void refresh()}
                disabled={isLoading}
                aria-label="Check for updates"
              >
                <RefreshCw className={cn('h-3 w-3', isLoading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {latestVersion && (
        <UpgradeDialog
          open={upgradeOpen}
          onOpenChange={setUpgradeOpen}
          targetVersion={latestVersion}
        />
      )}
    </>
  );
}
