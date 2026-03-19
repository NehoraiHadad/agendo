'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Globe, Info, Pencil, Plus, Server, Terminal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValueEditor } from '@/components/mcp/key-value-editor';
import { cn } from '@/lib/utils';
import type { McpServer } from '@/lib/types';

interface McpServerCardsProps {
  initialServers: McpServer[];
}

interface ServerFormState {
  name: string;
  description: string;
  transportType: 'stdio' | 'http';
  command: string;
  args: string;
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  isDefault: boolean;
}

const defaultForm: ServerFormState = {
  name: '',
  description: '',
  transportType: 'stdio',
  command: '',
  args: '',
  env: {},
  url: '',
  headers: {},
  enabled: true,
  isDefault: false,
};

export function McpServerCards({ initialServers }: McpServerCardsProps) {
  const [servers, setServers] = useState<McpServer[]>(initialServers);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [form, setForm] = useState<ServerFormState>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);

  function openAdd() {
    setEditingServer(null);
    setForm(defaultForm);
    setDialogOpen(true);
  }

  function openEdit(server: McpServer) {
    setEditingServer(server);
    setForm({
      name: server.name,
      description: server.description ?? '',
      transportType: server.transportType,
      command: server.command ?? '',
      args: (server.args ?? []).join(' '),
      env: server.env ?? {},
      url: server.url ?? '',
      headers: server.headers ?? {},
      enabled: server.enabled,
      isDefault: server.isDefault,
    });
    setDialogOpen(true);
  }

  function updateForm<K extends keyof ServerFormState>(key: K, value: ServerFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        transportType: form.transportType,
        command: form.transportType === 'stdio' ? form.command.trim() || null : null,
        args: form.transportType === 'stdio' ? form.args.trim().split(/\s+/).filter(Boolean) : [],
        env: form.transportType === 'stdio' ? form.env : {},
        url: form.transportType === 'http' ? form.url.trim() || null : null,
        headers: form.transportType === 'http' ? form.headers : {},
        enabled: form.enabled,
        isDefault: form.isDefault,
      };

      if (editingServer) {
        const res = await fetch(`/api/mcp-servers/${editingServer.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data } = (await res.json()) as { data: McpServer };
        setServers((prev) => prev.map((s) => (s.id === data.id ? data : s)));
        toast.success('MCP server updated');
      } else {
        const res = await fetch('/api/mcp-servers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data } = (await res.json()) as { data: McpServer };
        setServers((prev) => [...prev, data]);
        toast.success('MCP server added');
      }
      setDialogOpen(false);
    } catch {
      toast.error(editingServer ? 'Failed to update server' : 'Failed to add server');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(server: McpServer, enabled: boolean) {
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = (await res.json()) as { data: McpServer };
      setServers((prev) => prev.map((s) => (s.id === data.id ? data : s)));
    } catch {
      toast.error('Failed to update server');
    }
  }

  async function toggleDefault(server: McpServer, isDefault: boolean) {
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isDefault }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = (await res.json()) as { data: McpServer };
      setServers((prev) => prev.map((s) => (s.id === data.id ? data : s)));
    } catch {
      toast.error('Failed to update server');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/mcp-servers/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setServers((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      toast.success(`Deleted "${deleteTarget.name}"`);
    } catch {
      toast.error('Failed to delete server');
    } finally {
      setDeleteTarget(null);
    }
  }

  async function handleImport() {
    setImporting(true);
    try {
      const res = await fetch('/api/mcp-servers/import', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as {
        imported: string[];
        skipped: string[];
        errors: string[];
      };

      if (result.imported.length > 0) {
        toast.success(
          `Imported ${result.imported.length} server${result.imported.length !== 1 ? 's' : ''}`,
        );
        const listRes = await fetch('/api/mcp-servers');
        if (listRes.ok) {
          const updated = (await listRes.json()) as McpServer[];
          setServers(updated);
        }
      } else {
        toast.info('No new servers found to import');
      }
      if (result.errors.length > 0) {
        toast.error(`Errors: ${result.errors.join('; ')}`);
      }
    } catch {
      toast.error('Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground/40">
          {servers.length} server{servers.length !== 1 ? 's' : ''} registered
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={handleImport}
            disabled={importing}
          >
            <Download className="h-3 w-3" />
            <span className="hidden sm:inline">{importing ? 'Importing...' : 'Import'}</span>
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={openAdd}>
            <Plus className="h-3 w-3" />
            Add Server
          </Button>
        </div>
      </div>

      {servers.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No MCP servers registered"
          description="Add one or import from installed CLI configs."
          actions={[
            <Button
              key="import"
              variant="outline"
              size="sm"
              onClick={handleImport}
              disabled={importing}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Import
            </Button>,
            <Button key="add" size="sm" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Server
            </Button>,
          ]}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {servers.map((server) => (
            <div
              key={server.id}
              className={cn(
                'group relative rounded-xl border overflow-hidden transition-all duration-200',
                'hover:border-white/[0.12]',
                server.enabled
                  ? 'border-white/[0.08] bg-white/[0.015]'
                  : 'border-white/[0.04] bg-white/[0.005] opacity-60',
              )}
            >
              {/* Top accent bar */}
              <div
                className="h-[2px] w-full"
                style={{
                  background:
                    server.transportType === 'http'
                      ? 'linear-gradient(90deg, oklch(0.7 0.15 300 / 0.6) 0%, transparent 100%)'
                      : 'linear-gradient(90deg, oklch(0.7 0.15 220 / 0.6) 0%, transparent 100%)',
                  opacity: server.enabled ? 1 : 0.3,
                }}
              />

              <div className="p-4 space-y-3">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground/90 truncate">
                        {server.name}
                      </h3>
                      <TransportBadge type={server.transportType} />
                    </div>
                    <p className="text-[10px] text-muted-foreground/35 font-mono truncate mt-0.5">
                      {server.description ??
                        (server.transportType === 'stdio' ? server.command : server.url) ??
                        'No description'}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => openEdit(server)}
                      className="p-1.5 rounded-md text-muted-foreground/30 hover:text-foreground/60 hover:bg-white/[0.04] transition-colors"
                      aria-label={`Edit ${server.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(server)}
                      className="p-1.5 rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-white/[0.04] transition-colors"
                      aria-label={`Delete ${server.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Auto-include badge */}
                {server.isDefault && (
                  <Badge
                    variant="outline"
                    className="text-[10px] border-emerald-500/20 text-emerald-400/70 bg-emerald-500/[0.06]"
                  >
                    Auto-included in sessions
                  </Badge>
                )}

                {/* Toggles */}
                <div className="flex items-center gap-4 pt-2 border-t border-white/[0.04]">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={(v) => toggleEnabled(server, v)}
                      aria-label={`Toggle ${server.name} enabled`}
                      className="scale-90"
                    />
                    <span className="text-[11px] text-muted-foreground/45">Enabled</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={server.isDefault}
                      onCheckedChange={(v) => toggleDefault(server, v)}
                      aria-label={`Toggle ${server.name} auto-include`}
                      className="scale-90"
                    />
                    <span className="text-[11px] text-muted-foreground/45">Auto-include</span>
                    <span
                      className="text-muted-foreground/25 cursor-help"
                      title="Automatically included in all sessions without per-session selection"
                    >
                      <Info className="h-3 w-3" />
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingServer ? 'Edit MCP Server' : 'Add MCP Server'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name" className="text-xs">
                Name
              </Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(e) => updateForm('name', e.target.value)}
                placeholder="my-server"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-desc" className="text-xs">
                Description <span className="text-muted-foreground/50">(optional)</span>
              </Label>
              <Textarea
                id="mcp-desc"
                value={form.description}
                onChange={(e) => updateForm('description', e.target.value)}
                placeholder="Short description"
                className="text-sm resize-none h-16"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Transport Type</Label>
              <Select
                value={form.transportType}
                onValueChange={(v) => updateForm('transportType', v as 'stdio' | 'http')}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">
                    <span className="flex items-center gap-2">
                      <Terminal className="h-3.5 w-3.5" /> stdio
                    </span>
                  </SelectItem>
                  <SelectItem value="http">
                    <span className="flex items-center gap-2">
                      <Globe className="h-3.5 w-3.5" /> http
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.transportType === 'stdio' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-command" className="text-xs">
                    Command
                  </Label>
                  <Input
                    id="mcp-command"
                    value={form.command}
                    onChange={(e) => updateForm('command', e.target.value)}
                    placeholder="npx"
                    className="h-8 text-sm font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-args" className="text-xs">
                    Args <span className="text-muted-foreground/50">(space-separated)</span>
                  </Label>
                  <Input
                    id="mcp-args"
                    value={form.args}
                    onChange={(e) => updateForm('args', e.target.value)}
                    placeholder="-y @modelcontextprotocol/server-filesystem /path"
                    className="h-8 text-sm font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Environment Variables</Label>
                  <KeyValueEditor
                    value={form.env}
                    onChange={(v) => updateForm('env', v)}
                    keyPlaceholder="VAR_NAME"
                    valuePlaceholder="value"
                  />
                </div>
              </>
            )}

            {form.transportType === 'http' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-url" className="text-xs">
                    URL
                  </Label>
                  <Input
                    id="mcp-url"
                    value={form.url}
                    onChange={(e) => updateForm('url', e.target.value)}
                    placeholder="https://example.com/mcp"
                    className="h-8 text-sm font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Headers</Label>
                  <KeyValueEditor
                    value={form.headers}
                    onChange={(v) => updateForm('headers', v)}
                    keyPlaceholder="Authorization"
                    valuePlaceholder="Bearer ..."
                  />
                </div>
              </>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
              <div className="flex items-center gap-2">
                <Switch
                  id="mcp-enabled"
                  checked={form.enabled}
                  onCheckedChange={(v) => updateForm('enabled', v)}
                />
                <Label htmlFor="mcp-enabled" className="text-xs cursor-pointer">
                  Enabled
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="mcp-default"
                  checked={form.isDefault}
                  onCheckedChange={(v) => updateForm('isDefault', v)}
                />
                <Label htmlFor="mcp-default" className="text-xs cursor-pointer">
                  Auto-include in sessions
                </Label>
              </div>
            </div>
          </div>

          <DialogFooter className="flex-col-reverse sm:flex-row gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : editingServer ? 'Save Changes' : 'Add Server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete MCP Server"
        description={`Are you sure you want to delete "${deleteTarget?.name ?? ''}"? This will also remove it from all project configurations.`}
        onConfirm={() => void handleDelete()}
      />
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
