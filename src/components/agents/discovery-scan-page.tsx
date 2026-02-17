'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { DiscoveryFilterBar, type FilterValue } from './discovery-filter-bar';
import { DiscoveredToolCard } from './discovered-tool-card';
import { triggerScan } from '@/lib/actions/discovery-actions';
import type { DiscoveredTool } from '@/lib/discovery';

export function DiscoveryScanPage() {
  const [tools, setTools] = useState<DiscoveredTool[]>([]);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [isScanning, startTransition] = useTransition();
  const [hasScanned, setHasScanned] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  function handleScan() {
    startTransition(async () => {
      setScanError(null);
      const result = await triggerScan();
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

  const counts: Record<string, number> = {};
  for (const tool of tools) {
    counts[tool.toolType] = (counts[tool.toolType] ?? 0) + 1;
  }

  const filtered = filter === 'all' ? tools : tools.filter((t) => t.toolType === filter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Discovery</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scan your system for CLI tools and AI agents.
          </p>
        </div>
        <Button onClick={handleScan} disabled={isScanning}>
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
            No scan results yet. Click &quot;Scan Now&quot; to discover tools on your system.
          </p>
        </div>
      )}

      {tools.length > 0 && (
        <>
          <DiscoveryFilterBar activeFilter={filter} onFilterChange={setFilter} counts={counts} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((tool) => (
              <DiscoveredToolCard
                key={tool.name}
                tool={tool}
                onConfirmed={handleConfirmed}
                onDismissed={handleDismissed}
              />
            ))}
          </div>
          {filtered.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              No tools match the selected filter.
            </p>
          )}
        </>
      )}
    </div>
  );
}
