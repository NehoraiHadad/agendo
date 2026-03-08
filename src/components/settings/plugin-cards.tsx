'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Puzzle, AlertTriangle } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { PluginInfo } from '@/lib/plugins/types';

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'oklch(0.7 0.18 145)';
    case 'disabled':
      return 'oklch(0.5 0.02 0)';
    case 'errored':
      return 'oklch(0.65 0.2 25)';
    default:
      return 'oklch(0.6 0.1 280)';
  }
}

function categoryLabel(category?: string): string {
  switch (category) {
    case 'integration':
      return 'Integration';
    case 'automation':
      return 'Automation';
    case 'agent':
      return 'Agent';
    case 'utility':
      return 'Utility';
    default:
      return 'Plugin';
  }
}

export function PluginCards() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/plugins')
      .then((res) => res.json())
      .then((data) => {
        setPlugins(data.data ?? []);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  async function toggleEnabled(pluginId: string, enabled: boolean) {
    try {
      const res = await fetch(`/api/plugins/${pluginId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPlugins((prev) =>
        prev.map((p) =>
          p.manifest.id === pluginId
            ? { ...p, status: enabled ? 'active' : 'disabled' }
            : p,
        ),
      );
      toast.success(enabled ? 'Plugin enabled' : 'Plugin disabled');
    } catch {
      toast.error('Failed to update plugin');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground/40 text-sm">
        Loading plugins...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground/40">
          {plugins.length} plugin{plugins.length !== 1 ? 's' : ''} available
        </p>
      </div>

      {plugins.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] p-8 text-center">
          <Puzzle className="h-8 w-8 mx-auto text-muted-foreground/20 mb-3" />
          <p className="text-sm text-muted-foreground/50">No plugins installed</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {plugins.map((plugin) => {
            const color = statusColor(plugin.status);
            return (
              <div
                key={plugin.manifest.id}
                className={cn(
                  'group rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] overflow-hidden transition-all duration-150',
                  plugin.status === 'disabled' && 'opacity-60',
                )}
              >
                {/* Accent bar */}
                <div
                  className="h-[2px] w-full"
                  style={{
                    background: `linear-gradient(90deg, ${color} 0%, ${color}33 100%)`,
                  }}
                />

                <div className="p-4 space-y-3">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Puzzle className="h-4 w-4 shrink-0" style={{ color }} />
                        <h3 className="text-sm font-medium text-foreground/90 truncate">
                          {plugin.manifest.name}
                        </h3>
                      </div>
                      <p className="text-[11px] text-muted-foreground/40 mt-0.5 line-clamp-2">
                        {plugin.manifest.description}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="shrink-0 text-[10px] px-1.5 py-0 h-4 border-white/[0.08] text-muted-foreground/40"
                    >
                      v{plugin.manifest.version}
                    </Badge>
                  </div>

                  {/* Error indicator */}
                  {plugin.status === 'errored' && plugin.lastError && (
                    <div className="flex items-start gap-2 rounded-lg bg-red-500/5 border border-red-500/10 px-2.5 py-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-400/60 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-red-400/60 line-clamp-2">{plugin.lastError}</p>
                    </div>
                  )}

                  {/* Footer */}
                  <div className="flex items-center justify-between pt-1 border-t border-white/[0.04]">
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 h-4 border-white/[0.06] text-muted-foreground/30"
                    >
                      {categoryLabel(plugin.manifest.category)}
                    </Badge>

                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground/30">
                        {plugin.status === 'active' ? 'Enabled' : 'Disabled'}
                      </span>
                      <Switch
                        checked={plugin.status === 'active'}
                        onCheckedChange={(checked) =>
                          toggleEnabled(plugin.manifest.id, checked)
                        }
                        className="h-4 w-7 data-[state=checked]:bg-primary/70"
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
