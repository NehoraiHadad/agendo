'use client';

import { useState } from 'react';
import { useDraft } from '@/hooks/use-draft';
import { ChevronDown, ChevronUp, Info, Loader2, Plus } from 'lucide-react';
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

const TEMPLATE_VARIABLES = [
  { variable: '{{task_title}}', description: 'Title of the assigned task' },
  { variable: '{{task_description}}', description: 'Full task description' },
  {
    variable: '{{input_context.promptAdditions}}',
    description: 'Extra prompt text from task context',
  },
  { variable: '{{input_context.workingDir}}', description: 'Working directory path' },
  { variable: '{{input_context.args.*}}', description: 'Custom arguments (dot-path access)' },
];

const SAMPLE_CONTEXT: Record<string, unknown> = {
  task_title: 'Fix authentication bug in login flow',
  task_description: 'Users report intermittent 401 errors when logging in with SSO.',
  input_context: {
    promptAdditions: 'Focus on the OAuth callback handler.',
    workingDir: '/home/ubuntu/projects/my-app',
    args: { priority: 'high' },
  },
};

function interpolatePreview(template: string): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_match, path: string) => {
    const parts = path.split('.');
    let value: unknown = SAMPLE_CONTEXT;
    for (const part of parts) {
      if (value === null || value === undefined || typeof value !== 'object') return '';
      value = (value as Record<string, unknown>)[part];
    }
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

interface AddCapabilityDialogProps {
  agentId: string;
  onCreated: (cap: AgentCapability) => void;
  /** Pre-fill form fields (used for cloning) */
  initialValues?: {
    label: string;
    description: string;
    promptTemplate: string;
    dangerLevel: string;
  };
  /** Override trigger button */
  trigger?: React.ReactNode;
  /** Override dialog title */
  dialogTitle?: string;
}

export function AddCapabilityDialog({
  agentId,
  onCreated,
  initialValues,
  trigger,
  dialogTitle,
}: AddCapabilityDialogProps) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(initialValues?.label ?? '');
  const [description, setDescription] = useState(initialValues?.description ?? '');
  const [promptTemplate, setPromptTemplate] = useState(initialValues?.promptTemplate ?? '');
  const [dangerLevel, setDangerLevel] = useState(initialValues?.dangerLevel ?? '0');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showVarHelp, setShowVarHelp] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const { saveDraft, getDraft, clearDraft } = useDraft(`draft:capability:new:${agentId}`);

  function saveCombinedDraft(
    nextLabel = label,
    nextDescription = description,
    nextPromptTemplate = promptTemplate,
  ) {
    saveDraft(
      JSON.stringify({
        label: nextLabel,
        description: nextDescription,
        promptTemplate: nextPromptTemplate,
      }),
    );
  }

  function reset() {
    setLabel(initialValues?.label ?? '');
    setDescription(initialValues?.description ?? '');
    setPromptTemplate(initialValues?.promptTemplate ?? '');
    setDangerLevel(initialValues?.dangerLevel ?? '0');
    setError(null);
    setShowVarHelp(false);
    setShowPreview(false);
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
      clearDraft();
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
        if (v) {
          const saved = getDraft();
          if (saved) {
            try {
              const parsed = JSON.parse(saved) as {
                label?: string;
                description?: string;
                promptTemplate?: string;
              };
              if (parsed.label) setLabel(parsed.label);
              if (parsed.description) setDescription(parsed.description);
              if (parsed.promptTemplate) setPromptTemplate(parsed.promptTemplate);
            } catch {
              // ignore malformed draft
            }
          }
        } else {
          reset();
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="px-2 sm:px-3" title="Add Capability">
            <Plus className="size-4" />
            <span className="hidden sm:inline ml-1.5">Add Capability</span>
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dialogTitle ?? 'Add Capability'}</DialogTitle>
          <DialogDescription>Create a prompt-mode capability for this agent.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cap-label">Label</Label>
            <Input
              id="cap-label"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                saveCombinedDraft(e.target.value);
              }}
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
              onChange={(e) => {
                setDescription(e.target.value);
                saveCombinedDraft(undefined, e.target.value);
              }}
              placeholder="Short description of what this capability does..."
              className="min-h-[72px] resize-none"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="cap-prompt">
                Prompt Template{' '}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <button
                type="button"
                onClick={() => setShowVarHelp(!showVarHelp)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Info className="size-3" />
                Variables
                {showVarHelp ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
              </button>
            </div>
            {showVarHelp && (
              <div className="rounded-md border bg-muted/50 p-2 text-xs space-y-1">
                <p className="text-muted-foreground mb-1.5">
                  Use <code className="text-foreground">{'{{variable}}'}</code> syntax. Resolved at
                  session start from the linked task:
                </p>
                {TEMPLATE_VARIABLES.map((v) => (
                  <div key={v.variable} className="flex gap-2">
                    <code className="text-[11px] font-mono text-foreground shrink-0">
                      {v.variable}
                    </code>
                    <span className="text-muted-foreground">{v.description}</span>
                  </div>
                ))}
              </div>
            )}
            <Textarea
              id="cap-prompt"
              value={promptTemplate}
              onChange={(e) => {
                setPromptTemplate(e.target.value);
                saveCombinedDraft(undefined, undefined, e.target.value);
              }}
              placeholder="e.g. {{task_title}}\n\n{{task_description}}"
              className="min-h-[80px] resize-none text-sm font-mono"
            />
            {promptTemplate.includes('{{') && (
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => setShowPreview(!showPreview)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  Preview
                  {showPreview ? (
                    <ChevronUp className="size-3" />
                  ) : (
                    <ChevronDown className="size-3" />
                  )}
                </button>
                {showPreview && (
                  <pre className="rounded-md border bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                    {interpolatePreview(promptTemplate)}
                  </pre>
                )}
              </div>
            )}
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
