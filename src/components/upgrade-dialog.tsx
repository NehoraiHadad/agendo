'use client';

import { useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, ServerCrash, Zap } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useUpgrade, type UpgradePhase } from '@/hooks/use-upgrade';
import type { UpgradeStage } from '@/lib/upgrade/upgrade-manager';

interface UpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetVersion: string;
}

// ---------------------------------------------------------------------------
// Stage badge
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<UpgradeStage, string> = {
  idle: 'Waiting',
  preflight: 'Pre-flight',
  install: 'Installing',
  build: 'Building',
  migrate: 'Migrating',
  restart: 'Restarting',
  done: 'Done',
  failed: 'Failed',
};

const STAGE_COLORS: Record<UpgradeStage, string> = {
  idle: 'text-muted-foreground',
  preflight: 'text-blue-400',
  install: 'text-blue-400',
  build: 'text-blue-400',
  migrate: 'text-blue-400',
  restart: 'text-amber-400',
  done: 'text-emerald-400',
  failed: 'text-red-400',
};

function StageBadge({ stage }: { stage: UpgradeStage }) {
  return (
    <span className={cn('text-xs font-mono uppercase tracking-wider', STAGE_COLORS[stage])}>
      {STAGE_LABELS[stage]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Phase overlay banner
// ---------------------------------------------------------------------------

function PhaseBanner({
  phase,
  elapsedPollSeconds,
  error,
}: {
  phase: UpgradePhase;
  elapsedPollSeconds: number;
  error: string | null;
}) {
  if (phase === 'server-down') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span>Server is restarting… polling for new version ({elapsedPollSeconds}s)</span>
      </div>
    );
  }

  if (phase === 'reconnected') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span>Upgrade complete! Reloading…</span>
      </div>
    );
  }

  if (phase === 'failed' && error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        <XCircle className="h-3.5 w-3.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function UpgradeDialog({ open, onOpenChange, targetVersion }: UpgradeDialogProps) {
  const { phase, stage, logLines, error, elapsedPollSeconds, startUpgrade, reset } = useUpgrade();

  const logEndRef = useRef<HTMLDivElement>(null);
  const isActive = phase === 'streaming' || phase === 'server-down';

  // Auto-scroll log to bottom as new lines arrive
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logLines.length]);

  // Start upgrade when dialog opens
  useEffect(() => {
    if (open && phase === 'idle' && targetVersion) {
      void startUpgrade(targetVersion);
    }
  }, [open, phase, targetVersion, startUpgrade]);

  // Reset when dialog closes
  const handleOpenChange = (next: boolean) => {
    if (!next && isActive) return; // prevent close during upgrade
    if (!next) reset();
    onOpenChange(next);
  };

  const canClose = phase === 'reconnected' || phase === 'failed' || phase === 'idle';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-400" />
            Upgrading to v{targetVersion}
            <StageBadge stage={stage} />
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {/* Phase banner */}
          <PhaseBanner phase={phase} elapsedPollSeconds={elapsedPollSeconds} error={error} />

          {/* Live log terminal */}
          <ScrollArea className="h-80 rounded-md border border-border/50 bg-black/40">
            <pre className="p-3 text-[11px] font-mono leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
              {logLines.length === 0 ? (
                <span className="text-muted-foreground/40">Starting upgrade…</span>
              ) : (
                logLines.map((line, i) => {
                  const isError =
                    line.toLowerCase().includes('[x]') || line.toLowerCase().includes('error');
                  const isSuccess =
                    line.toLowerCase().includes('[+]') || line.toLowerCase().includes('complete');
                  const isWarn =
                    line.toLowerCase().includes('[!]') || line.toLowerCase().includes('warn');
                  return (
                    <span
                      key={i}
                      className={cn(
                        'block',
                        isError && 'text-red-400',
                        isSuccess && 'text-emerald-400',
                        isWarn && 'text-amber-400',
                      )}
                    >
                      {line}
                    </span>
                  );
                })
              )}
              <div ref={logEndRef} />
            </pre>
          </ScrollArea>

          {/* Server restart note */}
          {(stage === 'restart' || phase === 'server-down') && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
              <ServerCrash className="h-3.5 w-3.5 shrink-0" />
              <span>
                The server will restart — this page will reload automatically once the new version
                is live.
              </span>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {isActive && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mr-auto">
              <Loader2 className="h-3 w-3 animate-spin" />
              Upgrade in progress…
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!canClose}
            onClick={() => handleOpenChange(false)}
          >
            {canClose ? 'Close' : 'Please wait…'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
