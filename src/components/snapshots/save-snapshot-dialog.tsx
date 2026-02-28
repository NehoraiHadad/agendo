'use client';

import { useState } from 'react';
import { Camera, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { ContextSnapshot } from '@/lib/types';

export interface SaveSnapshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  projectId: string | null;
}

interface FindingsState {
  filesExplored: string[];
  findings: string[];
  nextSteps: string[];
}

function TagInput({
  label,
  placeholder,
  items,
  onChange,
}: {
  label: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  function addItem() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange([...items, trimmed]);
    setDraft('');
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground uppercase tracking-wider">{label}</Label>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.07] text-muted-foreground/80"
            >
              <span className="max-w-[180px] truncate">{item}</span>
              <button
                type="button"
                onClick={() => removeItem(i)}
                className="text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors ml-0.5"
                aria-label={`Remove ${item}`}
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addItem();
            }
          }}
          placeholder={placeholder}
          className="h-7 text-xs flex-1"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={addItem}
          disabled={!draft.trim()}
          className="h-7 w-7 p-0 text-muted-foreground/40 hover:text-foreground"
          aria-label="Add item"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function SaveSnapshotDialog({
  open,
  onOpenChange,
  sessionId,
  projectId,
}: SaveSnapshotDialogProps) {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showFindings, setShowFindings] = useState(false);
  const [findings, setFindings] = useState<FindingsState>({
    filesExplored: [],
    findings: [],
    nextSteps: [],
  });

  function resetForm() {
    setName('');
    setSummary('');
    setFindings({ filesExplored: [], findings: [], nextSteps: [] });
    setShowFindings(false);
  }

  function handleOpenChange(v: boolean) {
    if (!v) resetForm();
    onOpenChange(v);
  }

  async function handleSave() {
    const trimmedName = name.trim();
    const trimmedSummary = summary.trim();
    if (!trimmedName || !trimmedSummary || isSaving) return;
    if (!projectId) {
      toast.error('Session is not linked to a project');
      return;
    }

    setIsSaving(true);
    try {
      const hasFindings =
        findings.filesExplored.length > 0 ||
        findings.findings.length > 0 ||
        findings.nextSteps.length > 0;

      await apiFetch<ApiResponse<ContextSnapshot>>('/api/snapshots', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          sessionId,
          name: trimmedName,
          summary: trimmedSummary,
          ...(hasFindings
            ? {
                keyFindings: {
                  filesExplored: findings.filesExplored,
                  findings: findings.findings,
                  hypotheses: [],
                  nextSteps: findings.nextSteps,
                },
              }
            : {}),
        }),
      });

      toast.success('Snapshot saved', {
        description: trimmedName,
      });
      handleOpenChange(false);
    } catch (err) {
      toast.error('Failed to save snapshot', {
        description: err instanceof Error ? err.message : undefined,
      });
      setIsSaving(false);
    }
  }

  const isValid = name.trim().length > 0 && summary.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Camera className="size-4 text-teal-400" />
            Save Context Snapshot
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 pt-1">
          {/* Name */}
          <div className="space-y-2">
            <Label
              htmlFor="snap-name"
              className="text-xs text-muted-foreground uppercase tracking-wider"
            >
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="snap-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Auth bug investigation"
              className="text-sm"
              autoFocus
            />
          </div>

          {/* Summary */}
          <div className="space-y-2">
            <Label
              htmlFor="snap-summary"
              className="text-xs text-muted-foreground uppercase tracking-wider"
            >
              Summary <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="snap-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What were you investigating? What did you find?"
              className="min-h-[80px] resize-none text-sm"
            />
          </div>

          {/* Key findings toggle */}
          <button
            type="button"
            onClick={() => setShowFindings((v) => !v)}
            className={cn(
              'text-xs text-left transition-colors flex items-center gap-1.5',
              showFindings
                ? 'text-teal-400'
                : 'text-muted-foreground/50 hover:text-muted-foreground/80',
            )}
          >
            <Plus
              className={cn(
                'size-3 transition-transform',
                showFindings ? 'rotate-45 text-teal-400' : '',
              )}
            />
            {showFindings ? 'Hide key findings' : 'Add key findings (optional)'}
          </button>

          {showFindings && (
            <div
              className={cn('space-y-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4')}
            >
              <TagInput
                label="Files explored"
                placeholder="src/auth/*.ts  (press Enter)"
                items={findings.filesExplored}
                onChange={(v) => setFindings((f) => ({ ...f, filesExplored: v }))}
              />
              <TagInput
                label="Findings"
                placeholder="Token refresh failing on expiry  (press Enter)"
                items={findings.findings}
                onChange={(v) => setFindings((f) => ({ ...f, findings: v }))}
              />
              <TagInput
                label="Next steps"
                placeholder="Check middleware ordering  (press Enter)"
                items={findings.nextSteps}
                onChange={(v) => setFindings((f) => ({ ...f, nextSteps: v }))}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!isValid || isSaving}
            className="gap-1.5 bg-teal-600 hover:bg-teal-500 text-white border-0"
          >
            {isSaving ? <Loader2 className="size-3 animate-spin" /> : <Camera className="size-3" />}
            Save Snapshot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
