'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { GitBranch, Loader2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-types';
import type { CliSessionEntry } from '@/lib/services/cli-import/types';

interface SessionEntryCardProps {
  entry: CliSessionEntry;
}

export function SessionEntryCard({ entry }: SessionEntryCardProps) {
  const router = useRouter();
  const [importing, setImporting] = useState(false);

  const handleContinue = async () => {
    setImporting(true);
    try {
      const result = await apiFetch<{ data: { sessionId: string } }>('/api/sessions/import', {
        method: 'POST',
        body: JSON.stringify({
          cliSessionId: entry.cliSessionId,
          jsonlPath: entry.jsonlPath,
          projectPath: entry.projectPath,
        }),
      });
      router.push(`/sessions/${result.data.sessionId}`);
    } catch (err) {
      console.error('Import failed:', err);
      setImporting(false);
    }
  };

  const summary = entry.firstPrompt ?? entry.cliSessionId.slice(0, 8);

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 hover:border-white/[0.1] transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground/80 truncate">{summary}</p>
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground/50 flex-wrap">
          <span suppressHydrationWarning>
            {formatDistanceToNow(new Date(entry.modified), { addSuffix: true })}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare className="size-3" />
            {entry.messageCount} msgs
          </span>
          {entry.gitBranch && (
            <Badge
              variant="outline"
              className="text-[10px] font-mono border-white/[0.08] text-muted-foreground/60 px-1.5 py-0"
            >
              <GitBranch className="size-2.5 mr-0.5" />
              {entry.gitBranch}
            </Badge>
          )}
          {entry.alreadyImported && (
            <Badge
              variant="outline"
              className="text-[10px] border-amber-500/30 text-amber-400/70 px-1.5 py-0"
            >
              imported
            </Badge>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="border-white/[0.1] shrink-0"
        onClick={handleContinue}
        disabled={importing || entry.alreadyImported}
      >
        {importing ? <Loader2 className="size-3.5 animate-spin" /> : 'Continue'}
      </Button>
    </div>
  );
}
