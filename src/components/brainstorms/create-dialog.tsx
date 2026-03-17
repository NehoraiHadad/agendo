'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { useDraft } from '@/hooks/use-draft';
import { toast } from 'sonner';
import {
  Dialog,
  DialogBody,
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
import { Badge } from '@/components/ui/badge';
import { getAgentColor, getInitials } from '@/lib/utils/brainstorm-colors';
import { deriveProvider } from '@/lib/utils/session-controls';
import { PLAYBOOK_PRESETS, PLAYBOOK_DEFAULTS } from '@/lib/brainstorm/playbook';
import type { BrainstormConfig } from '@/lib/db/schema';

// ============================================================================
// Types
// ============================================================================

interface AgentOption {
  id: string;
  name: string;
  slug: string;
  binaryPath: string;
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

interface ModelOption {
  id: string;
  label: string;
  description: string;
}

interface CompletedRoom {
  id: string;
  title: string;
  synthesis: string;
  createdAt: string;
}

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected project ID (e.g. when opened from a project page) */
  projectId?: string;
}

// ============================================================================
// Draft shape (serialized to JSON in useDraft)
// ============================================================================

interface DraftState {
  title?: string;
  topic?: string;
  selectedProjectId?: string;
  maxWaves?: number;
  presetId?: string;
  config?: BrainstormConfig;
}

// ============================================================================
// Section header
// ============================================================================

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-[10px] font-semibold text-muted-foreground/30 uppercase tracking-widest">
        {children}
      </span>
      <div className="flex-1 h-px bg-white/[0.04]" />
    </div>
  );
}

// ============================================================================
// Form content
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
  presetId: string;
  onPresetChange: (presetId: string) => void;
  participants: ParticipantSelection[];
  toggleAgent: (agent: AgentOption) => void;
  isAgentSelected: (id: string) => boolean;
  setParticipantModel: (agentId: string, model: string) => void;
  agents: AgentOption[];
  projects: ProjectOption[];
  isLoadingAgents: boolean;
  isLoadingProjects: boolean;
  showProjectSelector: boolean;
  modelsByProvider: Record<string, ModelOption[]>;
  loadingProviders: Set<string>;
  completedRooms: CompletedRoom[];
  selectedRelatedIds: string[];
  toggleRelatedRoom: (roomId: string) => void;
  isLoadingCompletedRooms: boolean;
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
  presetId,
  onPresetChange,
  participants,
  toggleAgent,
  isAgentSelected,
  setParticipantModel,
  agents,
  projects,
  isLoadingAgents,
  isLoadingProjects,
  showProjectSelector,
  modelsByProvider,
  loadingProviders,
  completedRooms,
  selectedRelatedIds,
  toggleRelatedRoom,
  isLoadingCompletedRooms,
}: FormContentProps) {
  return (
    <div className="space-y-5">
      <SectionHeader>Details</SectionHeader>

      {/* Title */}
      <div className="space-y-1.5">
        <Label htmlFor="brainstorm-title" className="text-xs font-medium text-foreground/70">
          Title
        </Label>
        <Input
          dir="auto"
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
          dir="auto"
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

      {/* Related brainstorms — only show when project is selected and completed rooms exist */}
      {completedRooms.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-foreground/70">
            Related Brainstorms
            <span className="text-muted-foreground/40 font-normal ml-1">(optional, max 3)</span>
          </Label>
          <p className="text-[10px] text-muted-foreground/40">
            Link previous discussions to provide context. Syntheses will be injected into the
            preamble.
          </p>
          <div className="space-y-1.5 max-h-36 overflow-y-auto">
            {completedRooms.map((room) => {
              const isSelected = selectedRelatedIds.includes(room.id);
              const atLimit = selectedRelatedIds.length >= 3 && !isSelected;
              const dateStr = new Date(room.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              });
              const preview =
                room.synthesis.slice(0, 100) + (room.synthesis.length > 100 ? '…' : '');
              return (
                <div
                  key={room.id}
                  className={`rounded-md border px-3 py-2 transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-blue-500/40 bg-blue-500/[0.05]'
                      : atLimit
                        ? 'border-white/[0.04] bg-white/[0.01] opacity-40 cursor-not-allowed'
                        : 'border-white/[0.06] bg-white/[0.01] hover:border-white/[0.12]'
                  }`}
                  onClick={() => !atLimit && toggleRelatedRoom(room.id)}
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={isSelected}
                      disabled={atLimit}
                      onCheckedChange={() => toggleRelatedRoom(room.id)}
                      className="shrink-0"
                    />
                    <span className="text-xs text-foreground/80 font-medium flex-1 truncate">
                      {room.title}
                    </span>
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">
                      {dateStr}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground/40 mt-1 ml-6 line-clamp-2">
                    {preview}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isLoadingCompletedRooms && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
          <Loader2 className="size-3 animate-spin" />
          Loading related brainstorms...
        </div>
      )}

      <SectionHeader>Configuration</SectionHeader>

      {/* Preset selector */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-foreground/70">Preset</Label>
        <Select value={presetId} onValueChange={onPresetChange}>
          <SelectTrigger className="text-sm">
            <SelectValue placeholder="Custom configuration" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="custom">Custom</SelectItem>
            {PLAYBOOK_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {presetId !== 'custom' && (
          <p className="text-[10px] text-muted-foreground/40">
            {PLAYBOOK_PRESETS.find((p) => p.id === presetId)?.description}
          </p>
        )}
      </div>

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
          Maximum rounds of responses (default: {PLAYBOOK_DEFAULTS.waveTimeoutSec}s per wave)
        </p>
      </div>

      <SectionHeader>Participants</SectionHeader>

      {/* Participants */}
      <div className="space-y-3">
        <div className="flex items-center justify-end">
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
            {agents.map((agent, agentIndex) => {
              const selected = isAgentSelected(agent.id);
              const participant = participants.find((p) => p.agentId === agent.id);
              const colors = getAgentColor(agent.slug, agentIndex);
              const initials = getInitials(agent.name);
              const borderColorClass = colors.border.replace('border-l-', 'border-');
              return (
                <div
                  key={agent.id}
                  className={`rounded-lg border transition-colors ${
                    selected
                      ? `${borderColorClass} bg-white/[0.02]`
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
                    <div
                      className={`shrink-0 size-6 rounded-full flex items-center justify-center text-[9px] font-bold border ${borderColorClass} bg-white/[0.03]`}
                    >
                      <span className={colors.dot}>{initials}</span>
                    </div>
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
                      {(() => {
                        const provider = deriveProvider(agent.binaryPath);
                        const models = modelsByProvider[provider] ?? [];
                        const isLoading = loadingProviders.has(provider);

                        if (isLoading) {
                          return (
                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
                              <Loader2 className="size-3 animate-spin" />
                              Loading...
                            </div>
                          );
                        }

                        return (
                          <Select
                            value={participant.model || '__default__'}
                            onValueChange={(v) =>
                              setParticipantModel(agent.id, v === '__default__' ? '' : v)
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px] flex-1 border-white/[0.08] bg-transparent">
                              <SelectValue placeholder="Default model" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default__">Default</SelectItem>
                              {models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  {m.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );
                      })()}
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

  // Form state — initialized from draft on first open
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? '');
  const [maxWaves, setMaxWaves] = useState(10);
  const [presetId, setPresetId] = useState('custom');
  const [config, setConfig] = useState<BrainstormConfig>({});
  const [participants, setParticipants] = useState<ParticipantSelection[]>([]);

  // Loading states
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Model picker state
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelOption[]>>({});
  const [loadingProviders, setLoadingProviders] = useState<Set<string>>(new Set());

  // Related brainstorms state
  const [completedRooms, setCompletedRooms] = useState<CompletedRoom[]>([]);
  const [selectedRelatedIds, setSelectedRelatedIds] = useState<string[]>([]);
  const [isLoadingCompletedRooms, setIsLoadingCompletedRooms] = useState(false);

  // Draft persistence via existing useDraft hook (debounced localStorage)
  const { saveDraft, getDraft, clearDraft } = useDraft('draft:brainstorm:new');

  /** Save current form state as draft (called on every field change) */
  const persistDraft = useCallback(() => {
    if (!title && !topic) return;
    const draft: DraftState = { title, topic, selectedProjectId, maxWaves, presetId, config };
    saveDraft(JSON.stringify(draft));
  }, [title, topic, selectedProjectId, maxWaves, presetId, config, saveDraft]);

  // Auto-save draft whenever form fields change
  useEffect(() => {
    if (!open) return;
    persistDraft();
  }, [open, persistDraft]);

  /** Restore draft into form state — called from onOpenChange (event handler, not effect) */
  const restoreDraft = useCallback(() => {
    const raw = getDraft();
    if (!raw) return;
    try {
      const draft = JSON.parse(raw) as DraftState;
      if (draft.title) setTitle(draft.title);
      if (draft.topic) setTopic(draft.topic);
      if (draft.selectedProjectId && !projectId) setSelectedProjectId(draft.selectedProjectId);
      if (draft.maxWaves) setMaxWaves(draft.maxWaves);
      if (draft.presetId) setPresetId(draft.presetId);
      if (draft.config) setConfig(draft.config);
    } catch {
      // malformed draft — ignore
    }
  }, [getDraft, projectId]);

  /** Fetch models for a provider (with in-memory caching). */
  const fetchModelsForProvider = useCallback(
    async (provider: string) => {
      if (modelsByProvider[provider] ?? loadingProviders.has(provider)) return;
      setLoadingProviders((prev) => new Set(prev).add(provider));
      try {
        const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`);
        if (res.ok) {
          const body = (await res.json()) as { data: ModelOption[] };
          setModelsByProvider((prev) => ({ ...prev, [provider]: body.data ?? [] }));
        }
      } catch {
        // ignore — model list is non-critical
      } finally {
        setLoadingProviders((prev) => {
          const next = new Set(prev);
          next.delete(provider);
          return next;
        });
      }
    },
    [modelsByProvider, loadingProviders],
  );

  // Fetch agents and projects when dialog opens
  useEffect(() => {
    if (!open) return;

    setIsLoadingAgents(true);
    fetch('/api/agents')
      .then((r) => r.json())
      .then((body: { data: AgentOption[] }) => setAgents(body.data ?? []))
      .catch(() => toast.error('Failed to load agents'))
      .finally(() => setIsLoadingAgents(false));

    if (!projectId) {
      setIsLoadingProjects(true);
      fetch('/api/projects')
        .then((r) => r.json())
        .then((body: { data: ProjectOption[] }) => setProjects(body.data ?? []))
        .catch(() => toast.error('Failed to load projects'))
        .finally(() => setIsLoadingProjects(false));
    }
  }, [open, projectId]);

  // Fetch completed brainstorm rooms when project changes (for "Related brainstorms" picker)
  useEffect(() => {
    const resolvedProject = projectId ?? selectedProjectId;
    if (!open || !resolvedProject) {
      setCompletedRooms([]);
      return;
    }

    setIsLoadingCompletedRooms(true);
    fetch(`/api/brainstorms/completed?projectId=${encodeURIComponent(resolvedProject)}`)
      .then((r) => r.json())
      .then((body: { data: CompletedRoom[] }) => setCompletedRooms(body.data ?? []))
      .catch(() => setCompletedRooms([]))
      .finally(() => setIsLoadingCompletedRooms(false));
  }, [open, projectId, selectedProjectId]);

  const toggleRelatedRoom = useCallback((roomId: string) => {
    setSelectedRelatedIds((prev) => {
      if (prev.includes(roomId)) {
        return prev.filter((id) => id !== roomId);
      }
      if (prev.length >= 3) return prev;
      return [...prev, roomId];
    });
  }, []);

  /** Handle preset selection — applies preset config and maxWaves */
  const handlePresetChange = useCallback((newPresetId: string) => {
    setPresetId(newPresetId);
    if (newPresetId === 'custom') {
      setConfig({});
      setMaxWaves(10);
      return;
    }
    const preset = PLAYBOOK_PRESETS.find((p) => p.id === newPresetId);
    if (preset) {
      setConfig(preset.config);
      setMaxWaves(preset.maxWaves);
    }
  }, []);

  const isAgentSelected = useCallback(
    (agentId: string) => participants.some((p) => p.agentId === agentId),
    [participants],
  );

  const toggleAgent = useCallback(
    (agent: AgentOption) => {
      setParticipants((prev) => {
        if (prev.some((p) => p.agentId === agent.id)) {
          return prev.filter((p) => p.agentId !== agent.id);
        }
        // Fetch models for this agent's provider
        const provider = deriveProvider(agent.binaryPath);
        void fetchModelsForProvider(provider);
        return [
          ...prev,
          { agentId: agent.id, agentName: agent.name, agentSlug: agent.slug, model: '' },
        ];
      });
    },
    [fetchModelsForProvider],
  );

  const setParticipantModel = useCallback((agentId: string, model: string) => {
    setParticipants((prev) => prev.map((p) => (p.agentId === agentId ? { ...p, model } : p)));
  }, []);

  const canSubmit =
    title.trim().length > 0 &&
    topic.trim().length > 0 &&
    !!(selectedProjectId || projectId) &&
    participants.length >= 2 &&
    !isSubmitting;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        restoreDraft();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, restoreDraft],
  );

  const handleClose = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    const resolvedProjectId = projectId ?? selectedProjectId;
    if (!resolvedProjectId) {
      toast.error('Please select a project');
      return;
    }

    setIsSubmitting(true);
    try {
      // Merge relatedRoomIds into config if any are selected
      const finalConfig = { ...config };
      if (selectedRelatedIds.length > 0) {
        finalConfig.relatedRoomIds = selectedRelatedIds;
      }
      const hasConfig = Object.keys(finalConfig).length > 0;

      const createRes = await fetch('/api/brainstorms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          topic: topic.trim(),
          projectId: resolvedProjectId,
          maxWaves,
          config: hasConfig ? finalConfig : undefined,
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
      setPresetId('custom');
      setConfig({});
      setParticipants([]);
      setSelectedRelatedIds([]);

      onOpenChange(false);
      router.push(`/brainstorms/${room.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create brainstorm');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    clearDraft,
    config,
    projectId,
    selectedProjectId,
    selectedRelatedIds,
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
    presetId,
    onPresetChange: handlePresetChange,
    participants,
    toggleAgent,
    isAgentSelected,
    setParticipantModel,
    agents,
    projects,
    isLoadingAgents,
    isLoadingProjects,
    showProjectSelector: !projectId,
    modelsByProvider,
    loadingProviders,
    completedRooms,
    selectedRelatedIds,
    toggleRelatedRoom,
    isLoadingCompletedRooms,
  };

  const footerProps: FooterContentProps = {
    participants,
    isSubmitting,
    canSubmit,
    onCancel: handleClose,
    onSubmit: () => void handleSubmit(),
  };

  // Responsive Dialog — uses default centered positioning from DialogContent.
  // On mobile, max-h-[90dvh] from DialogContent + flex-col + overflow-y-auto
  // on DialogBody ensures the form is scrollable without fighting transforms.
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 p-0 overflow-hidden max-sm:max-w-[calc(100%-1rem)] sm:max-w-lg">
        <DialogHeader className="px-5 pt-5 pb-4 shrink-0">
          <DialogTitle className="text-base">New Brainstorm Room</DialogTitle>
        </DialogHeader>

        <Separator className="shrink-0" />

        <DialogBody className="px-5 py-4">
          <FormContent {...formProps} />
        </DialogBody>

        <Separator className="shrink-0" />

        <DialogFooter className="px-5 py-4 shrink-0 flex-row items-center justify-between gap-3">
          <FooterContent {...footerProps} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
