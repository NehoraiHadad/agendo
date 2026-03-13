'use client';

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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
// Draft persistence (localStorage)
// ============================================================================

const DRAFT_KEY = 'agendo:brainstorm-draft';

interface DraftState {
  title: string;
  topic: string;
  selectedProjectId: string;
  maxWaves: number;
  participants: ParticipantSelection[];
  savedAt: number;
}

/** Max age of a draft before it's considered stale (24 hours) */
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadDraft(projectId?: string): Partial<DraftState> | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as DraftState;
    // Discard stale drafts
    if (Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    // If projectId is pre-set and differs from draft, ignore project-specific fields
    if (projectId && draft.selectedProjectId && draft.selectedProjectId !== projectId) {
      return { title: draft.title, topic: draft.topic, maxWaves: draft.maxWaves };
    }
    return draft;
  } catch {
    return null;
  }
}

function saveDraft(state: Omit<DraftState, 'savedAt'>): void {
  try {
    const draft: DraftState = { ...state, savedAt: Date.now() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

// ============================================================================
// Mobile detection hook
// ============================================================================

function useIsMobile(breakpoint = 640): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
      mq.addEventListener('change', onStoreChange);
      return () => mq.removeEventListener('change', onStoreChange);
    },
    [breakpoint],
  );

  const getSnapshot = useCallback(
    () => window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches,
    [breakpoint],
  );

  // SSR: assume desktop (dialog is the safe default)
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ============================================================================
// Form content (shared between Dialog and Sheet)
// ============================================================================

interface FormContentProps {
  title: string;
  setTitle: (v: string) => void;
  topic: string;
  setTopic: (v: string) => void;
  selectedProjectId: string;
  setSelectedProjectId: (v: string) => void;
  maxWaves: number;
  setMaxWaves: (v: number) => void;
  participants: ParticipantSelection[];
  toggleAgent: (agent: AgentOption) => void;
  isAgentSelected: (id: string) => boolean;
  setParticipantModel: (agentId: string, model: string) => void;
  agents: AgentOption[];
  projects: ProjectOption[];
  isLoadingAgents: boolean;
  isLoadingProjects: boolean;
  showProjectSelector: boolean;
}

function FormContent({
  title,
  setTitle,
  topic,
  setTopic,
  selectedProjectId,
  setSelectedProjectId,
  maxWaves,
  setMaxWaves,
  participants,
  toggleAgent,
  isAgentSelected,
  setParticipantModel,
  agents,
  projects,
  isLoadingAgents,
  isLoadingProjects,
  showProjectSelector,
}: FormContentProps) {
  return (
    <div className="space-y-5">
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

      {/* Project selector */}
      {showProjectSelector && (
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
                    <span className="text-[10px] text-muted-foreground/35 font-mono hidden sm:inline">
                      {agent.slug}
                    </span>
                  </div>

                  {selected && participant && (
                    <div
                      className="px-3 pb-2.5 flex items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="text-[10px] text-muted-foreground/40 shrink-0">Model:</span>
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
  );
}

// ============================================================================
// Footer (shared)
// ============================================================================

interface FooterContentProps {
  participants: ParticipantSelection[];
  isSubmitting: boolean;
  canSubmit: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}

function FooterContent({
  participants,
  isSubmitting,
  canSubmit,
  onCancel,
  onSubmit,
}: FooterContentProps) {
  return (
    <>
      {participants.length < 2 && (
        <span className="text-[10px] text-amber-400/60 flex-1">Select at least 2 participants</span>
      )}
      <div className="flex gap-2 ml-auto w-full sm:w-auto">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
          className="flex-1 sm:flex-none"
        >
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={!canSubmit} className="gap-1.5 flex-1 sm:flex-none">
          {isSubmitting ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Plus className="size-3.5" />
              Start
            </>
          )}
        </Button>
      </div>
    </>
  );
}

// ============================================================================
// Main component
// ============================================================================

export function CreateBrainstormDialog({ open, onOpenChange, projectId }: CreateDialogProps) {
  const router = useRouter();
  const isMobile = useIsMobile();

  // Form state — initialized from draft on first open
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

  // Track whether we've hydrated from draft for this open cycle
  const hydratedRef = useRef(false);

  // Load draft + data when dialog opens
  useEffect(() => {
    if (!open) {
      hydratedRef.current = false;
      return;
    }

    // Hydrate from draft (only once per open cycle)
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      const draft = loadDraft(projectId);
      if (draft) {
        if (draft.title) setTitle(draft.title);
        if (draft.topic) setTopic(draft.topic);
        if (draft.selectedProjectId && !projectId) setSelectedProjectId(draft.selectedProjectId);
        if (draft.maxWaves) setMaxWaves(draft.maxWaves);
        // Don't restore participants — agent IDs might be stale
      }
    }

    // Fetch agents
    setIsLoadingAgents(true);
    fetch('/api/agents')
      .then((r) => r.json())
      .then((body: { data: AgentOption[] }) => setAgents(body.data ?? []))
      .catch(() => toast.error('Failed to load agents'))
      .finally(() => setIsLoadingAgents(false));

    // Fetch projects (if not pre-set)
    if (!projectId) {
      setIsLoadingProjects(true);
      fetch('/api/projects')
        .then((r) => r.json())
        .then((body: { data: ProjectOption[] }) => setProjects(body.data ?? []))
        .catch(() => toast.error('Failed to load projects'))
        .finally(() => setIsLoadingProjects(false));
    }
  }, [open, projectId]);

  // Save draft on every change (debounced naturally by React batching)
  useEffect(() => {
    if (!open) return;
    // Only save if the user has typed something
    if (!title && !topic) return;
    saveDraft({ title, topic, selectedProjectId, maxWaves, participants });
  }, [open, title, topic, selectedProjectId, maxWaves, participants]);

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
    !!(selectedProjectId || projectId) &&
    participants.length >= 2 &&
    !isSubmitting;

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    const resolvedProjectId = projectId ?? selectedProjectId;
    if (!resolvedProjectId) {
      toast.error('Please select a project');
      return;
    }

    setIsSubmitting(true);
    try {
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

      const startRes = await fetch(`/api/brainstorms/${room.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!startRes.ok) {
        toast.warning('Room created but failed to start. You can start it from the room page.');
      } else {
        toast.success('Brainstorm started!');
      }

      // Clear draft on successful submit
      clearDraft();

      // Reset form
      setTitle('');
      setTopic('');
      setSelectedProjectId(projectId ?? '');
      setMaxWaves(10);
      setParticipants([]);

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

  const formProps: FormContentProps = {
    title,
    setTitle,
    topic,
    setTopic,
    selectedProjectId,
    setSelectedProjectId,
    maxWaves,
    setMaxWaves,
    participants,
    toggleAgent,
    isAgentSelected,
    setParticipantModel,
    agents,
    projects,
    isLoadingAgents,
    isLoadingProjects,
    showProjectSelector: !projectId,
  };

  const footerProps: FooterContentProps = {
    participants,
    isSubmitting,
    canSubmit,
    onCancel: handleClose,
    onSubmit: () => void handleSubmit(),
  };

  // ── Mobile: bottom sheet (full height, slide up) ──────────────────────
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="h-[95dvh] rounded-t-xl flex flex-col p-0 gap-0"
        >
          {/* Header with close button */}
          <SheetHeader className="px-4 pt-4 pb-3 shrink-0 flex-row items-center justify-between">
            <SheetTitle className="text-base">New Brainstorm</SheetTitle>
            <button
              onClick={handleClose}
              className="rounded-full p-1.5 hover:bg-white/[0.06] transition-colors -mr-1"
            >
              <X className="size-4 text-muted-foreground" />
            </button>
          </SheetHeader>

          <Separator className="shrink-0" />

          {/* Scrollable body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            <FormContent {...formProps} />
          </div>

          <Separator className="shrink-0" />

          {/* Sticky footer */}
          <div className="px-4 py-3 shrink-0 flex flex-row items-center gap-3 safe-area-bottom">
            <FooterContent {...footerProps} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  // ── Desktop: centered dialog ──────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle className="text-base">New Brainstorm Room</DialogTitle>
        </DialogHeader>

        <Separator className="shrink-0" />

        <DialogBody className="px-6 py-4">
          <FormContent {...formProps} />
        </DialogBody>

        <Separator className="shrink-0" />

        <DialogFooter className="px-6 py-4 shrink-0 flex-row items-center justify-between gap-3">
          <FooterContent {...footerProps} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
