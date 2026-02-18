'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ParsedFlag } from '@/lib/db/schema';

interface RefreshFlagsButtonProps {
  agentId: string;
  initialFlags: ParsedFlag[];
}

export function RefreshFlagsButton({ agentId, initialFlags }: RefreshFlagsButtonProps) {
  const [flags, setFlags] = useState<ParsedFlag[]>(initialFlags);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/refresh-flags`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { data: { parsedFlags: ParsedFlag[] } };
      const updated = data.data.parsedFlags;
      setFlags(updated);
      toast.success(`Flags refreshed — ${updated.length} flag${updated.length !== 1 ? 's' : ''} found`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      toast.error(`Refresh failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw className={`size-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Flags
        </Button>
        <Badge variant="secondary">{flags.length} flags</Badge>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {flags.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No flags parsed yet. Click &quot;Refresh Flags&quot; to parse the agent&apos;s CLI flags.
        </p>
      ) : (
        <div className="space-y-1.5 max-h-64 overflow-auto">
          {flags.map((flag, i) => (
            <div key={i} className="flex items-start gap-2 text-sm py-1 border-b border-border/50 last:border-0">
              <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded text-foreground shrink-0">
                {flag.flags.join(', ')}
              </code>
              <span className="text-muted-foreground text-xs leading-relaxed">
                {flag.description}
                {flag.takesValue && flag.valueHint && (
                  <span className="ml-1 text-zinc-500">&lt;{flag.valueHint}&gt;</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
