'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';

// ============================================================================
// Types
// ============================================================================

interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface ParticipantSelection {
  agentId: string;
  agentName: string;
  agentSlug: string;
  model: string;
}

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected project ID (e.g. when opened from a project page) */
  projectId?: string;
}

// ============================================================================
// Main component
// ============================================================================

export function CreateBrainstormDialog({ open, onOpenChange, projectId }: CreateDialogProps) {
  const router = useRouter();

  // Form state
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? '');
  const [maxWaves, setMaxWaves] = useState(10);
  const [participants, setParticipants] = useState<ParticipantSelection[]>([]);

  // Loading states
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load agents and projects when dialog opens
  useEffect(() => {
    if (!open) return;

    setIsLoadingAgents(true);
    fetch('/api/agents')
      .then((r) => r.json())
      .then((body: { data: AgentOption[] }) => {
        setAgents(body.data ?? []);
      })
      .catch(() => toast.error('Failed to load agents'))
      .finally(() => setIsLoadingAgents(false));

    if (!projectId) {
      setIsLoadingProjects(true);
      fetch('/api/projects')
        .then((r) => r.json())
        .then((body: { data: ProjectOption[] }) => {
          setProjects(body.data ?? []);
        })
        .catch(() => toast.error('Failed to load projects'))
        .finally(() => setIsLoadingProjects(false));
    }
  }, [open, projectId]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setTitle('');
      setTopic('');
      setSelectedProjectId(projectId ?? '');
      setMaxWaves(10);
      setParticipants([]);
    }
  }, [open, projectId]);

  const isAgentSelected = useCallback(
    (agentId: string) => participants.some((p) => p.agentId === agentId),
    [participants],
  );

  const toggleAgent = useCallback((agent: AgentOption) => {
    setParticipants((prev) => {
      if (prev.some((p) => p.agentId === agent.id)) {
        return prev.filter((p) => p.agentId !== agent.id);
      }
      return [
        ...prev,
        { agentId: agent.id, agentName: agent.name, agentSlug: agent.slug, model: '' },
      ];
    });
  }, []);

  const setParticipantModel = useCallback((agentId: string, model: string) => {
    setParticipants((prev) => prev.map((p) => (p.agentId === agentId ? { ...p, model } : p)));
  }, []);

  const canSubmit =
    title.trim().length > 0 &&
    topic.trim().length > 0 &&
    (selectedProjectId || projectId) &&
    participants.length >= 2 &&
    !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    const resolvedProjectId = projectId ?? selectedProjectId;
    if (!resolvedProjectId) {
      toast.error('Please select a project');
      return;
    }

    setIsSubmitting(true);
    try {
      // Step 1: Create the room
      const createRes = await fetch('/api/brainstorms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          topic: topic.trim(),
          projectId: resolvedProjectId,
          maxWaves,
          participants: participants.map((p) => ({
            agentId: p.agentId,
            model: p.model || undefined,
          })),
        }),
      });

      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${createRes.status}`);
      }

      const { data: room } = (await createRes.json()) as { data: { id: string } };

      // Step 2: Start the brainstorm
      const startRes = await fetch(`/api/brainstorms/${room.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!startRes.ok) {
        // Navigate to room anyway so user can manually start
        toast.warning('Room created but failed to start. You can start it from the room page.');
      } else {
        toast.success('Brainstorm started!');
      }

      onOpenChange(false);
      router.push(`/brainstorms/${room.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create brainstorm');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    projectId,
    selectedProjectId,
    title,
    topic,
    maxWaves,
    participants,
    onOpenChange,
    router,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle className="text-base">New Brainstorm Room</DialogTitle>
        </DialogHeader>

        <Separator className="shrink-0" />

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-4 space-y-5">
            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="brainstorm-title" className="text-xs font-medium text-foreground/70">
                Title
              </Label>
              <Input
                id="brainstorm-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Brainstorm room title..."
                className="text-sm"
              />
            </div>

            {/* Topic */}
            <div className="space-y-1.5">
              <Label htmlFor="brainstorm-topic" className="text-xs font-medium text-foreground/70">
                Topic
              </Label>
              <Textarea
                id="brainstorm-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Describe the topic or question for the agents to discuss..."
                rows={3}
                className="text-sm resize-none"
              />
            </div>

            {/* Project selector (only when not pre-selected) */}
            {!projectId && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-foreground/70">Project</Label>
                {isLoadingProjects ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                    <Loader2 className="size-3 animate-spin" />
                    Loading projects...
                  </div>
                ) : (
                  <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                    <SelectTrigger className="text-sm">
                      <SelectValue placeholder="Select a project..." />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Max waves */}
            <div className="space-y-1.5">
              <Label htmlFor="max-waves" className="text-xs font-medium text-foreground/70">
                Max Waves
              </Label>
              <Input
                id="max-waves"
                type="number"
                min={1}
                max={50}
                value={maxWaves}
                onChange={(e) => setMaxWaves(Math.max(1, parseInt(e.target.value) || 10))}
                className="text-sm w-24"
              />
              <p className="text-[10px] text-muted-foreground/40">
                Maximum rounds of responses (default: 10)
              </p>
            </div>

            <Separator />

            {/* Participants */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium text-foreground/70">Participants</Label>
                <span className="text-[10px] text-muted-foreground/40">
                  {participants.length} selected · min 2
                </span>
              </div>

              {isLoadingAgents ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/50 py-4 justify-center">
                  <Loader2 className="size-3 animate-spin" />
                  Loading agents...
                </div>
              ) : agents.length === 0 ? (
                <p className="text-xs text-muted-foreground/40 py-4 text-center">
                  No agents found. Add agents first.
                </p>
              ) : (
                <div className="space-y-2">
                  {agents.map((agent) => {
                    const selected = isAgentSelected(agent.id);
                    const participant = participants.find((p) => p.agentId === agent.id);
                    return (
                      <div
                        key={agent.id}
                        className={`rounded-lg border transition-colors ${
                          selected
                            ? 'border-primary/30 bg-primary/[0.04]'
                            : 'border-white/[0.06] bg-white/[0.01]'
                        }`}
                      >
                        {/* Agent row */}
                        <div
                          className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
                          onClick={() => toggleAgent(agent)}
                        >
                          <Checkbox
                            checked={selected}
                            onCheckedChange={() => toggleAgent(agent)}
                            className="shrink-0"
                          />
                          <span className="text-sm text-foreground/80 flex-1">{agent.name}</span>
                          <span className="text-[10px] text-muted-foreground/35 font-mono">
                            {agent.slug}
                          </span>
                        </div>

                        {/* Model override (when selected) */}
                        {selected && participant && (
                          <div
                            className="px-3 pb-2.5 flex items-center gap-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="text-[10px] text-muted-foreground/40 shrink-0">
                              Model override:
                            </span>
                            <Input
                              value={participant.model}
                              onChange={(e) => setParticipantModel(agent.id, e.target.value)}
                              placeholder="default"
                              className="h-6 text-[11px] border-white/[0.08] bg-transparent"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>

        <Separator className="shrink-0" />

        <DialogFooter className="px-6 py-4 shrink-0 flex-row items-center justify-between gap-3">
          {participants.length < 2 && (
            <span className="text-[10px] text-amber-400/60 flex-1">
              Select at least 2 participants
            </span>
          )}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={!canSubmit} className="gap-1.5">
              {isSubmitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="size-3.5" />
                  Start Brainstorm
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
