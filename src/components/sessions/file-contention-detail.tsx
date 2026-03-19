'use client';

import Link from 'next/link';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { getTeamColor } from '@/lib/utils/team-colors';
import type { ContentionAlert } from '@/hooks/use-file-contention';

/** Map agent slugs to team color names for dot rendering. */
const AGENT_COLOR_MAP: Record<string, string> = {
  'claude-code-1': 'orange',
  'codex-cli-1': 'green',
  'gemini-cli-1': 'blue',
  'github-copilot-cli': 'purple',
};

interface FileContentionDetailProps {
  alert: ContentionAlert;
  currentSessionId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function FileContentionDetail({
  alert,
  currentSessionId,
  open,
  onOpenChange,
}: FileContentionDetailProps) {
  const isCritical = alert.severity === 'critical';

  // Build per-file session map for display
  // For simplicity, show all sessions under each file (the worker already filtered for overlap)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[420px] max-w-[90vw] bg-[oklch(0.085_0_0)] border-l border-white/[0.06] p-0 flex flex-col"
      >
        {/* Header */}
        <SheetHeader className="px-4 pt-4 pb-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle
              className={`size-4 shrink-0 ${isCritical ? 'text-red-400' : 'text-amber-400'}`}
            />
            <SheetTitle className="text-sm font-semibold text-foreground/90">
              File Contention
            </SheetTitle>
            <span
              className={`ml-auto text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                isCritical
                  ? 'text-red-400 bg-red-500/10 border-red-500/20'
                  : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
              }`}
            >
              {alert.severity}
            </span>
          </div>
        </SheetHeader>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
          {/* Severity description */}
          <p className={`text-xs font-medium ${isCritical ? 'text-red-400' : 'text-amber-400'}`}>
            {isCritical
              ? '\u26A0 CRITICAL \u2014 Same branch overwrite risk'
              : '\u26A1 WARNING \u2014 Merge conflict risk'}
          </p>

          {/* Per-file breakdown */}
          <div className="space-y-3">
            {alert.conflictingFiles.map((filePath) => (
              <div key={filePath} className="space-y-1.5">
                {/* File path */}
                <p className="font-mono text-xs text-foreground/70 truncate" title={filePath}>
                  {filePath}
                </p>

                {/* Sessions touching this file */}
                <div className="ml-2 space-y-1.5 border-l border-white/[0.06] pl-3">
                  {alert.sessions.map((s) => {
                    const colorName = AGENT_COLOR_MAP[s.agentSlug] ?? undefined;
                    const colors = getTeamColor(colorName);
                    const isThis = s.sessionId === currentSessionId;

                    return (
                      <div key={s.sessionId} className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className={`${colors.dot} text-sm leading-none`}>{'\u25CF'}</span>
                          <span className="text-xs text-foreground/80 font-medium">
                            {s.agentName}
                          </span>
                          <span className="text-[10px] text-muted-foreground/40 font-mono">
                            ({s.branch})
                          </span>
                          {isThis && (
                            <span className="text-[10px] text-muted-foreground/40 italic">
                              {'\u2190'} this session
                            </span>
                          )}
                        </div>
                        {s.taskTitle && (
                          <p className="text-[10px] text-muted-foreground/35 ml-4 truncate">
                            Task: &quot;{s.taskTitle}&quot;
                          </p>
                        )}
                        {!isThis && (
                          <Link
                            href={`/sessions/${s.sessionId}`}
                            className="ml-4 inline-flex items-center gap-1 text-[10px] text-primary/60 hover:text-primary/90 transition-colors"
                          >
                            <ExternalLink className="size-2.5" />
                            Open Session
                          </Link>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Divider */}
          <div className="border-t border-white/[0.06]" />

          {/* Suggested actions */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">
              Suggested actions
            </p>
            <ul className="text-xs text-muted-foreground/50 space-y-1 list-disc list-inside">
              <li>Move one agent to a worktree</li>
              <li>Coordinate via team messages</li>
              <li>Stagger file edits across sessions</li>
            </ul>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
