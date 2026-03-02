'use client';

import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { AgentCapability } from '@/lib/types';

interface AddCapabilityDialogProps {
  agentId: string;
  onCreated: (cap: AgentCapability) => void;
}

export function AddCapabilityDialog({ agentId, onCreated }: AddCapabilityDialogProps) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [promptTemplate, setPromptTemplate] = useState('');
  const [dangerLevel, setDangerLevel] = useState('0');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setLabel('');
    setDescription('');
    setPromptTemplate('');
    setDangerLevel('0');
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;

    const key = label
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch<ApiResponse<AgentCapability>>(
        `/api/agents/${agentId}/capabilities`,
        {
          method: 'POST',
          body: JSON.stringify({
            key,
            label: label.trim(),
            description: description.trim() || null,
            promptTemplate: promptTemplate.trim() || null,
            dangerLevel: parseInt(dangerLevel, 10),
          }),
        },
      );
      onCreated(res.data);
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create capability');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="px-2 sm:px-3" title="Add Capability">
          <Plus className="size-4" />
          <span className="hidden sm:inline ml-1.5">Add Capability</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Capability</DialogTitle>
          <DialogDescription>Create a prompt-mode capability for this agent.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cap-label">Label</Label>
            <Input
              id="cap-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Code Review"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cap-desc">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="cap-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description of what this capability does..."
              className="min-h-[72px] resize-none"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cap-prompt">
              Prompt Template <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="cap-prompt"
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              placeholder="Initial prompt sent to the agent when this capability is invoked..."
              className="min-h-[80px] resize-none text-sm font-mono"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cap-danger">Danger Level</Label>
            <Select value={dangerLevel} onValueChange={setDangerLevel}>
              <SelectTrigger id="cap-danger" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0 — Safe</SelectItem>
                <SelectItem value="1">1 — Low risk</SelectItem>
                <SelectItem value="2">2 — Caution</SelectItem>
                <SelectItem value="3">3 — Destructive</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={!label.trim() || isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add Capability
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
