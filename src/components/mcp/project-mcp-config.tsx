'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Globe, Server, Terminal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { KeyValueEditor } from './key-value-editor';
import type { McpServer, ProjectMcpServer } from '@/lib/types';

interface ProjectMcpOverride extends ProjectMcpServer {
  mcpServer: McpServer;
}

interface ProjectMcpServerRow {
  server: McpServer;
  override: ProjectMcpOverride | null;
}

interface ProjectMcpConfigProps {
  projectId: string;
  allServers: McpServer[];
  overrides: ProjectMcpOverride[];
}

export function ProjectMcpConfig({ projectId, allServers, overrides }: ProjectMcpConfigProps) {
  const overrideMap = new Map<string, ProjectMcpOverride>(overrides.map((o) => [o.mcpServerId, o]));

  // Local state: tracks per-server enabled + envOverrides
  const [enabledMap, setEnabledMap] = useState<Map<string, boolean>>(() => {
    const m = new Map<string, boolean>();
    for (const server of allServers) {
      const override = overrideMap.get(server.id);
      if (override !== undefined) {
        m.set(server.id, override.enabled);
      } else {
        m.set(server.id, server.isDefault);
      }
    }
    return m;
  });

  const [envOverridesMap, setEnvOverridesMap] = useState<Map<string, Record<string, string>>>(
    () => {
      const m = new Map<string, Record<string, string>>();
      for (const override of overrides) {
        m.set(override.mcpServerId, override.envOverrides ?? {});
      }
      return m;
    },
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function handleToggle(serverId: string, enabled: boolean) {
    setEnabledMap((prev) => new Map(prev).set(serverId, enabled));
    setSavingId(serverId);
    try {
      const envOverrides = envOverridesMap.get(serverId) ?? {};
      const res = await fetch(`/api/projects/${projectId}/mcp-servers/${serverId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, envOverrides }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Revert
      setEnabledMap((prev) => new Map(prev).set(serverId, !enabled));
      toast.error('Failed to update server config');
    } finally {
      setSavingId(null);
    }
  }

  async function handleSaveEnvOverrides(serverId: string) {
    setSavingId(serverId);
    try {
      const enabled = enabledMap.get(serverId) ?? false;
      const envOverrides = envOverridesMap.get(serverId) ?? {};
      const res = await fetch(`/api/projects/${projectId}/mcp-servers/${serverId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, envOverrides }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Environment overrides saved');
    } catch {
      toast.error('Failed to save env overrides');
    } finally {
      setSavingId(null);
    }
  }

  if (allServers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-white/[0.08] p-12 text-center">
        <Server className="h-10 w-10 mx-auto text-muted-foreground/20 mb-3" />
        <p className="text-sm text-muted-foreground">
          No MCP servers registered.{' '}
          <a href="/config/mcp-servers" className="text-primary hover:underline">
            Add servers in Config
          </a>{' '}
          to enable them here.
        </p>
      </div>
    );
  }

  const rows: ProjectMcpServerRow[] = allServers.map((server) => ({
    server,
    override: overrideMap.get(server.id) ?? null,
  }));

  return (
    <div className="space-y-1.5">
      {rows.map(({ server }) => {
        const isEnabled = enabledMap.get(server.id) ?? server.isDefault;
        const envOverrides = envOverridesMap.get(server.id) ?? {};
        const isExpanded = expandedId === server.id;
        const isSaving = savingId === server.id;
        const hasOverride = overrideMap.has(server.id);

        return (
          <div
            key={server.id}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden"
          >
            <div className="flex items-center gap-3 px-3 py-2.5">
              {/* Expand toggle for env overrides */}
              <button
                type="button"
                onClick={() => setExpandedId(isExpanded ? null : server.id)}
                className="text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors shrink-0"
                aria-label={isExpanded ? 'Collapse env overrides' : 'Expand env overrides'}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{server.name}</span>
                  <TransportBadge type={server.transportType} />
                  {server.isDefault && !hasOverride && (
                    <Badge
                      variant="outline"
                      className="text-[10px] border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                    >
                      Default
                    </Badge>
                  )}
                </div>
                {server.description && (
                  <p className="text-xs text-muted-foreground/50 truncate mt-0.5">
                    {server.description}
                  </p>
                )}
              </div>

              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => handleToggle(server.id, checked)}
                disabled={isSaving}
                aria-label={`Toggle ${server.name} for this project`}
              />
            </div>

            {/* Env overrides panel */}
            {isExpanded && (
              <div className="border-t border-white/[0.04] px-4 py-3 space-y-3">
                <p className="text-[11px] text-muted-foreground/50 uppercase tracking-wider font-medium">
                  Environment Variable Overrides
                </p>
                <p className="text-xs text-muted-foreground/40">
                  These values override the server&apos;s default env vars for this project only.
                </p>
                <KeyValueEditor
                  value={envOverrides}
                  onChange={(v) => setEnvOverridesMap((prev) => new Map(prev).set(server.id, v))}
                  keyPlaceholder="VAR_NAME"
                  valuePlaceholder="override value"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleSaveEnvOverrides(server.id)}
                    disabled={isSaving}
                  >
                    {isSaving ? 'Saving...' : 'Save Overrides'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TransportBadge({ type }: { type: 'stdio' | 'http' }) {
  if (type === 'http') {
    return (
      <Badge
        variant="outline"
        className="text-[10px] font-mono border-purple-500/30 text-purple-400 bg-purple-500/10"
      >
        <Globe className="h-2.5 w-2.5 mr-1" />
        http
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] font-mono border-blue-500/30 text-blue-400 bg-blue-500/10"
    >
      <Terminal className="h-2.5 w-2.5 mr-1" />
      stdio
    </Badge>
  );
}
