'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Pencil, Plus, Trash2, Server, Globe, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { EmptyState } from '@/components/ui/empty-state';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { KeyValueEditor } from './key-value-editor';
import type { McpServer } from '@/lib/types';

interface McpServersClientProps {
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

export function McpServersClient({ initialServers }: McpServersClientProps) {
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

  async function handleToggleEnabled(server: McpServer, enabled: boolean) {
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

  async function handleToggleDefault(server: McpServer, isDefault: boolean) {
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
      const { imported, skipped, errors } = result;

      if (imported.length > 0) {
        toast.success(
          `Imported ${imported.length} server${imported.length !== 1 ? 's' : ''}: ${imported.join(', ')}`,
        );
        // Refresh server list
        const listRes = await fetch('/api/mcp-servers');
        if (listRes.ok) {
          const updated = (await listRes.json()) as McpServer[];
          setServers(updated);
        }
      } else {
        toast.info('No new servers found to import');
      }
      if (skipped.length > 0) {
        toast.info(`Skipped: ${skipped.join(', ')}`);
      }
      if (errors.length > 0) {
        toast.error(`Errors: ${errors.join('; ')}`);
      }
    } catch {
      toast.error('Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] overflow-hidden shrink-0">
        <div
          className="h-[2px] w-full"
          style={{
            background:
              'linear-gradient(90deg, oklch(0.7 0.18 280 / 0.6) 0%, oklch(0.6 0.2 260 / 0.1) 100%)',
          }}
        />
        <div className="flex items-center gap-3 px-4 py-3">
          <div
            className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background:
                'linear-gradient(135deg, oklch(0.7 0.18 280 / 0.15) 0%, oklch(0.6 0.2 260 / 0.08) 100%)',
              border: '1px solid oklch(0.7 0.18 280 / 0.12)',
            }}
          >
            <Server className="h-4 w-4 text-primary/70" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-foreground/90">MCP Servers</h1>
            <p className="text-[11px] text-muted-foreground/35 mt-0.5">
              Register and manage Model Context Protocol servers
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={handleImport}
              disabled={importing}
              aria-label={importing ? 'Importing...' : 'Import from CLIs'}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">
                {importing ? 'Importing...' : 'Import from CLIs'}
              </span>
            </Button>
            <Button size="sm" className="h-7 text-xs gap-1.5" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Add Server</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Table */}
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
              Import from CLIs
            </Button>,
            <Button key="add" size="sm" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Server
            </Button>,
          ]}
        />
      ) : (
        <>
          {/* Mobile card list (hidden on md+) */}
          <div className="md:hidden space-y-2">
            {servers.map((server) => (
              <div
                key={server.id}
                className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-sm text-foreground truncate">
                        {server.name}
                      </span>
                      <TransportBadge type={server.transportType} />
                    </div>
                    {(server.description ??
                      (server.transportType === 'stdio' ? server.command : server.url)) && (
                      <p className="text-xs text-muted-foreground/50 truncate mt-0.5">
                        {server.description ??
                          (server.transportType === 'stdio' ? server.command : server.url)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => openEdit(server)}
                      aria-label={`Edit ${server.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(server)}
                      aria-label={`Delete ${server.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-4 pt-1 border-t border-white/[0.04]">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={(checked) => handleToggleEnabled(server, checked)}
                      aria-label={`Toggle ${server.name} enabled`}
                    />
                    <span className="text-xs text-muted-foreground/60">Enabled</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={server.isDefault}
                      onCheckedChange={(checked) => handleToggleDefault(server, checked)}
                      aria-label={`Toggle ${server.name} default`}
                    />
                    <span className="text-xs text-muted-foreground/60">Default</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop table (hidden on mobile) */}
          <div className="hidden md:block rounded-xl border border-white/[0.06] overflow-hidden overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader className="bg-white/[0.02]">
                <TableRow>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                    Name
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                    Type
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                    Description
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9 w-24 text-center">
                    Enabled
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9 w-24 text-center">
                    Default
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9 w-20">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((server) => (
                  <TableRow
                    key={server.id}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <TableCell className="font-medium text-foreground">{server.name}</TableCell>
                    <TableCell>
                      <TransportBadge type={server.transportType} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground/60 max-w-60 truncate">
                      {server.description ??
                        (server.transportType === 'stdio'
                          ? (server.command ?? '-')
                          : (server.url ?? '-'))}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={server.enabled}
                        onCheckedChange={(checked) => handleToggleEnabled(server, checked)}
                        aria-label={`Toggle ${server.name} enabled`}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={server.isDefault}
                        onCheckedChange={(checked) => handleToggleDefault(server, checked)}
                        aria-label={`Toggle ${server.name} default`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => openEdit(server)}
                          aria-label={`Edit ${server.name}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(server)}
                          aria-label={`Delete ${server.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingServer ? 'Edit MCP Server' : 'Add MCP Server'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
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

            {/* Description */}
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

            {/* Transport Type */}
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

            {/* stdio fields */}
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

            {/* http fields */}
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

            {/* Toggles */}
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
                  Default for all projects
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
