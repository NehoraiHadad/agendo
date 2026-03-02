'use client';

import { useState, useTransition } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DiscoveredToolCard } from './discovered-tool-card';
import { triggerScan } from '@/lib/actions/discovery-actions';
import type { DiscoveredTool } from '@/lib/discovery';

export function DiscoveryScanPage() {
  const [tools, setTools] = useState<DiscoveredTool[]>([]);
  const [isScanning, startTransition] = useTransition();
  const [hasScanned, setHasScanned] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');

  function handleScan() {
    // Parse comma/space-separated tool names from input
    const extraTargets = searchInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    startTransition(async () => {
      setScanError(null);
      const result = await triggerScan(extraTargets.length > 0 ? extraTargets : undefined);
      if (result.success && result.data) {
        setTools(result.data);
      } else {
        setScanError(result.error ?? 'Scan failed');
      }
      setHasScanned(true);
    });
  }

  function handleConfirmed(tool: DiscoveredTool) {
    setTools((prev) => prev.map((t) => (t.name === tool.name ? { ...t, isConfirmed: true } : t)));
  }

  function handleDismissed(toolName: string) {
    setTools((prev) => prev.filter((t) => t.name !== toolName));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Discovery</h1>
        <p className="mt-1 text-sm text-muted-foreground">Scan your system for AI agents.</p>
      </div>

      <div className="flex gap-3 items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="search-tools" className="text-xs text-muted-foreground">
            Specific tools to find{' '}
            <span className="text-muted-foreground/60">(optional — comma or space separated)</span>
          </Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              id="search-tools"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleScan();
              }}
              placeholder="e.g. claude, codex, gemini"
              className="pl-8 font-mono text-sm"
            />
          </div>
          <p className="text-xs text-muted-foreground/60">
            Leave empty to scan only for AI agents (claude, codex, gemini).
          </p>
        </div>
        <Button onClick={handleScan} disabled={isScanning} className="shrink-0">
          {isScanning ? 'Scanning...' : 'Scan Now'}
        </Button>
      </div>

      {scanError && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{scanError}</p>
        </div>
      )}

      {!hasScanned && tools.length === 0 && !scanError && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">
            No scan results yet. Click &quot;Scan Now&quot; to discover AI agents on your system.
          </p>
        </div>
      )}

      {hasScanned && tools.length === 0 && !scanError && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No agents found.{' '}
            {searchInput &&
              'Make sure the tool name matches its binary (e.g. "claude", not "claude-code").'}
          </p>
        </div>
      )}

      {tools.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {tools.map((tool) => (
            <DiscoveredToolCard
              key={tool.name}
              tool={tool}
              onConfirmed={handleConfirmed}
              onDismissed={handleDismissed}
            />
          ))}
        </div>
      )}
    </div>
  );
}
