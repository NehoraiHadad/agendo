'use client';

import { useState, useMemo, useSyncExternalStore, useCallback, useEffect } from 'react';
import { ArrowUpCircle, RefreshCw, Terminal, Zap, Sparkles } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverHeader,
  PopoverTitle,
} from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useVersionCheck } from '@/hooks/use-version-check';
import { UpgradeDialog } from '@/components/upgrade-dialog';
import { cn } from '@/lib/utils';
import type { ChangelogEntry } from '@/hooks/use-version-check';

/**
 * Version badge for the sidebar footer.
 * Shows current version with an update indicator when a newer version is available.
 * Includes a "What's New" tab with parsed changelog and optional AI summary.
 */
export function VersionBadge() {
  const {
    currentVersion,
    latestVersion,
    updateAvailable,
    checkedAt,
    changelog,
    isLoading,
    refresh,
  } = useVersionCheck();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);

  // Client-only flag — avoids Radix Popover hydration mismatch
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Check if AI is available on mount
  useEffect(() => {
    if (!mounted) return;
    fetch('/api/ai/call')
      .then((r) => r.json())
      .then((data: { available: boolean }) => setAiAvailable(data.available))
      .catch(() => setAiAvailable(false));
  }, [mounted]);

  const fetchAiSummary = useCallback(async () => {
    if (!changelog.length || aiSummary || aiLoading) return;
    setAiLoading(true);
    try {
      const entries = changelog
        .map(
          (e) =>
            `v${e.version} (${e.date}):\n${e.sections.map((s) => `${s.title}: ${s.items.join(', ')}`).join('\n')}`,
        )
        .join('\n\n');

      const res = await fetch('/api/ai/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: `Summarize this changelog in 2-3 short, friendly sentences for an end user. Focus on the most impactful changes. Be concise.\n\n${entries}`,
          maxTokens: 150,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { text: string };
        setAiSummary(data.text);
      }
    } catch {
      // Non-critical — AI summary is optional
    } finally {
      setAiLoading(false);
    }
  }, [changelog, aiSummary, aiLoading]);

  // Format on client only to avoid hydration mismatch
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
        <PopoverContent side="top" align="start" className="w-80">
          <PopoverHeader>
            <PopoverTitle className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
              Agendo
            </PopoverTitle>
          </PopoverHeader>

          <Tabs defaultValue="status" className="mt-2">
            <TabsList className="w-full">
              <TabsTrigger value="status" className="flex-1 text-xs">
                Status
              </TabsTrigger>
              <TabsTrigger
                value="whats-new"
                className="flex-1 text-xs"
                onClick={() => {
                  if (aiAvailable) void fetchAiSummary();
                }}
              >
                What&apos;s New
              </TabsTrigger>
            </TabsList>

            <TabsContent value="status" className="mt-2 space-y-3">
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
            </TabsContent>

            <TabsContent value="whats-new" className="mt-2">
              {/* AI Summary */}
              {aiAvailable && (
                <div className="mb-3">
                  {aiLoading && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground animate-pulse">
                      <Sparkles className="h-3 w-3" />
                      Generating summary...
                    </div>
                  )}
                  {aiSummary && (
                    <div className="rounded-md border border-purple-500/20 bg-purple-500/5 p-2.5">
                      <div className="flex items-center gap-1.5 text-[10px] font-medium text-purple-400 mb-1">
                        <Sparkles className="h-3 w-3" />
                        AI Summary
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">{aiSummary}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Changelog entries */}
              {changelog.length === 0 ? (
                <p className="text-xs text-muted-foreground/50 py-2">No changelog available.</p>
              ) : (
                <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                  {changelog.map((entry) => (
                    <ChangelogEntryCard key={entry.version} entry={entry} />
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
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

function ChangelogEntryCard({ entry }: { entry: ChangelogEntry }) {
  const [expanded, setExpanded] = useState(false);

  const totalItems = entry.sections.reduce((sum, s) => sum + s.items.length, 0);

  return (
    <div className="border-l-2 border-border/40 pl-2.5">
      <button
        className="flex items-center justify-between w-full text-left group cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div>
          <span className="text-xs font-medium">v{entry.version}</span>
          <span className="text-[10px] text-muted-foreground/50 ml-1.5">{entry.date}</span>
        </div>
        <span className="text-[10px] text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors">
          {totalItems} change{totalItems !== 1 ? 's' : ''} {expanded ? '−' : '+'}
        </span>
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {entry.sections.map((section) => (
            <div key={section.title}>
              <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                {section.title}
              </div>
              <ul className="mt-0.5 space-y-0.5">
                {section.items.map((item, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground leading-tight pl-2">
                    <span className="text-muted-foreground/30 mr-1">·</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
