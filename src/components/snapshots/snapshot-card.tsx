'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  RotateCcw,
  Trash2,
  FileSearch,
  Lightbulb,
  ArrowRight,
  Loader2,
  Bot,
  Sparkles,
  Brain,
  Code,
  Pencil,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { ContextSnapshot, SnapshotFindings, Agent } from '@/lib/types';

const LUCIDE_ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  brain: Brain,
  code: Code,
  bot: Bot,
};

function getAgentIcon(agent: Agent): React.ReactNode {
  const meta = agent.metadata as { icon?: string; color?: string } | null;
  const iconName = meta?.icon?.toLowerCase();
  const color = meta?.color;
  const Icon = iconName ? LUCIDE_ICONS[iconName] : undefined;
  if (Icon) return <Icon className="size-4" style={color ? { color } : undefined} />;
  return <Bot className="size-4 text-muted-foreground" />;
}

interface ResumeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: ContextSnapshot;
}

interface CapabilityOption {
  id: string;
  label: string;
  agentId: string;
  agentName: string;
}

function ResumeDialog({ open, onOpenChange, snapshot }: ResumeDialogProps) {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [capabilities, setCapabilities] = useState<CapabilityOption[]>([]);
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void fetch('/api/agents?group=ai')
      .then((r) => r.json() as Promise<{ data: Agent[] }>)
      .then(({ data }) => {
        const active = data.filter((a) => a.isActive);
        setAgents(active);
        if (active[0]) setSelectedAgentId(active[0].id);
      });
  }, [open]);

  useEffect(() => {
    if (!selectedAgentId) return;
    void fetch(`/api/agents/${selectedAgentId}/capabilities?mode=prompt`)
      .then((r) => r.json() as Promise<{ data: Array<{ id: string; label: string }> }>)
      .then(({ data }) => {
        setCapabilities(
          data.map((c) => ({ id: c.id, label: c.label, agentId: selectedAgentId, agentName: '' })),
        );
      });
  }, [selectedAgentId]);

  async function handleResume() {
    const cap = capabilities[0];
    if (!cap || isLaunching) return;
    setIsLaunching(true);
    setError(null);
    try {
      const res = await apiFetch<ApiResponse<{ sessionId: string }>>(
        `/api/snapshots/${snapshot.id}/resume`,
        {
          method: 'POST',
          body: JSON.stringify({
            agentId: selectedAgentId,
            capabilityId: cap.id,
            permissionMode: 'bypassPermissions',
          }),
        },
      );
      toast.success('Session resumed from snapshot');
      onOpenChange(false);
      router.push(`/sessions/${res.data.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume');
      setIsLaunching(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Resume Investigation</DialogTitle>
        </DialogHeader>

        <div className="space-y-1 py-1">
          <p className="text-xs text-muted-foreground/70 mb-4 leading-relaxed">
            A new session will be started with this snapshot&apos;s context pre-loaded.
          </p>

          <Label className="text-xs text-muted-foreground uppercase tracking-wider">Agent</Label>
          <div className="flex gap-2 flex-wrap mt-2">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelectedAgentId(agent.id)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors',
                  selectedAgentId === agent.id
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-white/[0.08] bg-card hover:border-white/[0.16] text-foreground',
                )}
              >
                {getAgentIcon(agent)}
                {agent.name}
              </button>
            ))}
            {agents.length === 0 && (
              <p className="text-sm text-muted-foreground/60">Loading agents…</p>
            )}
          </div>

          {error && <p className="text-xs text-destructive pt-2">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleResume()}
            disabled={!selectedAgentId || capabilities.length === 0 || isLaunching}
            className="gap-1.5"
          >
            {isLaunching ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RotateCcw className="size-3" />
            )}
            Resume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DeleteConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isDeleting: boolean;
}

function DeleteConfirm({ open, onOpenChange, onConfirm, isDeleting }: DeleteConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="text-base">Delete snapshot?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This snapshot will be permanently deleted. This cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={isDeleting}
            className="gap-1.5"
          >
            {isDeleting && <Loader2 className="size-3 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface EditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: ContextSnapshot;
  onUpdated: (updated: ContextSnapshot) => void;
}

function EditDialog({ open, onOpenChange, snapshot, onUpdated }: EditDialogProps) {
  const kf = snapshot.keyFindings as SnapshotFindings | null;
  const [name, setName] = useState(snapshot.name);
  const [summary, setSummary] = useState(snapshot.summary);
  const [filesExplored, setFilesExplored] = useState((kf?.filesExplored ?? []).join('\n'));
  const [findings, setFindings] = useState((kf?.findings ?? []).join('\n'));
  const [hypotheses, setHypotheses] = useState((kf?.hypotheses ?? []).join('\n'));
  const [nextSteps, setNextSteps] = useState((kf?.nextSteps ?? []).join('\n'));
  const [isSaving, setIsSaving] = useState(false);

  // Reset form when snapshot changes or dialog opens
  useEffect(() => {
    if (!open) return;
    const f = snapshot.keyFindings as SnapshotFindings | null;
    setName(snapshot.name);
    setSummary(snapshot.summary);
    setFilesExplored((f?.filesExplored ?? []).join('\n'));
    setFindings((f?.findings ?? []).join('\n'));
    setHypotheses((f?.hypotheses ?? []).join('\n'));
    setNextSteps((f?.nextSteps ?? []).join('\n'));
  }, [open, snapshot]);

  function splitLines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async function handleSave() {
    if (!name.trim() || !summary.trim() || isSaving) return;
    setIsSaving(true);
    try {
      const res = await apiFetch<ApiResponse<ContextSnapshot>>(`/api/snapshots/${snapshot.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          summary: summary.trim(),
          keyFindings: {
            filesExplored: splitLines(filesExplored),
            findings: splitLines(findings),
            hypotheses: splitLines(hypotheses),
            nextSteps: splitLines(nextSteps),
          },
        }),
      });
      toast.success('Snapshot updated');
      onUpdated(res.data);
      onOpenChange(false);
    } catch {
      toast.error('Failed to update snapshot');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Snapshot</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Snapshot name"
              className="text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Summary</Label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What was investigated and discovered"
              rows={4}
              className="text-sm font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Files explored (one per line)</Label>
            <Textarea
              value={filesExplored}
              onChange={(e) => setFilesExplored(e.target.value)}
              placeholder="src/auth/token.ts&#10;src/middleware.ts"
              rows={3}
              className="text-xs font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Findings (one per line)</Label>
            <Textarea
              value={findings}
              onChange={(e) => setFindings(e.target.value)}
              placeholder="Token expiry not checked before refresh"
              rows={3}
              className="text-xs font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Hypotheses (one per line)</Label>
            <Textarea
              value={hypotheses}
              onChange={(e) => setHypotheses(e.target.value)}
              placeholder="Race condition between refresh and new request"
              rows={2}
              className="text-xs font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Next steps (one per line)</Label>
            <Textarea
              value={nextSteps}
              onChange={(e) => setNextSteps(e.target.value)}
              placeholder="Add mutex around refresh&#10;Test with expired tokens"
              rows={2}
              className="text-xs font-mono"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!name.trim() || !summary.trim() || isSaving}
            className="gap-1.5"
          >
            {isSaving && <Loader2 className="size-3 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SnapshotCardProps {
  snapshot: ContextSnapshot;
  onDeleted: (id: string) => void;
  onUpdated?: (updated: ContextSnapshot) => void;
}

export function SnapshotCard({
  snapshot: initialSnapshot,
  onDeleted,
  onUpdated,
}: SnapshotCardProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [showResume, setShowResume] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Sync if parent re-renders with new data
  useEffect(() => {
    setSnapshot(initialSnapshot);
  }, [initialSnapshot]);

  function handleUpdated(updated: ContextSnapshot) {
    setSnapshot(updated);
    onUpdated?.(updated);
  }

  const findings = snapshot.keyFindings as SnapshotFindings | null;

  const topFiles = findings?.filesExplored?.slice(0, 2) ?? [];
  const topFindings = findings?.findings?.slice(0, 1) ?? [];
  const topNext = findings?.nextSteps?.slice(0, 1) ?? [];

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await apiFetch(`/api/snapshots/${snapshot.id}`, { method: 'DELETE' });
      toast.success('Snapshot deleted');
      setShowDelete(false);
      onDeleted(snapshot.id);
    } catch {
      toast.error('Failed to delete snapshot');
      setIsDeleting(false);
    }
  }

  return (
    <>
      <div
        className={cn(
          'group relative rounded-xl border border-white/[0.07] bg-[oklch(0.1_0_0)]',
          'hover:border-white/[0.12] hover:bg-[oklch(0.11_0_0)]',
          'transition-all duration-200',
          'overflow-hidden',
        )}
      >
        {/* Top accent line — snapshot colour teal */}
        <div className="h-[1px] w-full bg-gradient-to-r from-teal-500/50 via-teal-500/20 to-transparent" />

        <div className="p-4">
          {/* Header row */}
          <div className="flex items-start justify-between gap-2 mb-3">
            <h3 className="text-sm font-semibold text-foreground/90 leading-snug line-clamp-2 flex-1">
              {snapshot.name}
            </h3>
            <span
              className="text-[11px] text-muted-foreground/50 shrink-0 tabular-nums"
              suppressHydrationWarning
            >
              {formatDistanceToNow(new Date(snapshot.createdAt), { addSuffix: true })}
            </span>
          </div>

          {/* Summary */}
          <p className="text-xs text-muted-foreground/70 line-clamp-3 mb-3 leading-relaxed">
            {snapshot.summary}
          </p>

          {/* Key findings preview */}
          {(topFiles.length > 0 || topFindings.length > 0 || topNext.length > 0) && (
            <div className="space-y-1.5 mb-4 rounded-lg bg-white/[0.025] border border-white/[0.04] px-3 py-2.5">
              {topFiles.length > 0 && (
                <div className="flex items-start gap-2">
                  <FileSearch className="size-3 text-teal-400/70 mt-0.5 shrink-0" />
                  <span className="text-[11px] text-muted-foreground/60 line-clamp-1">
                    <span className="text-muted-foreground/40 mr-1">Files:</span>
                    {topFiles.join(', ')}
                    {(findings?.filesExplored?.length ?? 0) > 2 && (
                      <span className="text-muted-foreground/30 ml-1">
                        +{(findings?.filesExplored?.length ?? 0) - 2} more
                      </span>
                    )}
                  </span>
                </div>
              )}
              {topFindings.length > 0 && (
                <div className="flex items-start gap-2">
                  <Lightbulb className="size-3 text-amber-400/70 mt-0.5 shrink-0" />
                  <span className="text-[11px] text-muted-foreground/60 line-clamp-1">
                    <span className="text-muted-foreground/40 mr-1">Finding:</span>
                    {topFindings[0]}
                  </span>
                </div>
              )}
              {topNext.length > 0 && (
                <div className="flex items-start gap-2">
                  <ArrowRight className="size-3 text-blue-400/70 mt-0.5 shrink-0" />
                  <span className="text-[11px] text-muted-foreground/60 line-clamp-1">
                    <span className="text-muted-foreground/40 mr-1">Next:</span>
                    {topNext[0]}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowEdit(true)}
              className="h-7 w-7 p-0 text-muted-foreground/30 hover:text-foreground/70 hover:bg-white/[0.06] transition-colors"
              aria-label="Edit snapshot"
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDelete(true)}
              className="h-7 w-7 p-0 text-muted-foreground/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              aria-label="Delete snapshot"
            >
              <Trash2 className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowResume(true)}
              className="h-7 px-2.5 text-xs gap-1.5 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 border border-teal-500/20 transition-colors"
            >
              <RotateCcw className="size-3" />
              Resume
            </Button>
          </div>
        </div>
      </div>

      <EditDialog
        open={showEdit}
        onOpenChange={setShowEdit}
        snapshot={snapshot}
        onUpdated={handleUpdated}
      />
      <ResumeDialog open={showResume} onOpenChange={setShowResume} snapshot={snapshot} />
      <DeleteConfirm
        open={showDelete}
        onOpenChange={setShowDelete}
        onConfirm={() => void handleDelete()}
        isDeleting={isDeleting}
      />
    </>
  );
}
