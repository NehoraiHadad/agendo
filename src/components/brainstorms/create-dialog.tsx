'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, ChevronDown, ChevronUp, X } from 'lucide-react';
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
import { getAgentColor } from '@/lib/utils/brainstorm-colors';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { deriveProvider } from '@/lib/utils/session-controls';
import { PLAYBOOK_PRESETS, PLAYBOOK_DEFAULTS } from '@/lib/brainstorm/playbook';
import type { BrainstormConfig } from '@/lib/db/schema';
import { getErrorMessage } from '@/lib/utils/error-utils';
import { FALLBACK_TRIGGER_ERRORS } from '@/lib/fallback/policy';

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
  /** Unique instance key — allows multiple instances of the same agent */
  instanceId: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  model: string;
}

let instanceCounter = 0;
function nextInstanceId(): string {
  return `inst-${++instanceCounter}`;
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
  // Setup fields
  goal?: string;
  constraints?: string[];
  deliverableType?: BrainstormConfig['deliverableType'];
  targetAudience?: string;
}

const DEFAULT_DELIVERABLE_TYPE: BrainstormConfig['deliverableType'] = 'exploration';

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
  addAgent: (agent: AgentOption) => void;
  agentInstanceCount: (agentId: string) => number;
  removeParticipantInstance: (instanceId: string) => void;
  setParticipantModel: (instanceId: string, model: string) => void;
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
  // Setup fields
  goal: string;
  setGoal: (v: string) => void;
  constraints: string[];
  setConstraints: (v: string[]) => void;
  deliverableType: BrainstormConfig['deliverableType'];
  setDeliverableType: (v: BrainstormConfig['deliverableType']) => void;
  targetAudience: string;
  setTargetAudience: (v: string) => void;
  fallbackMode: NonNullable<BrainstormConfig['fallback']>['mode'];
  setFallbackMode: (v: NonNullable<BrainstormConfig['fallback']>['mode']) => void;
  preservePinnedModel: boolean;
  setPreservePinnedModel: (v: boolean) => void;
  fallbackTriggerErrors: string[];
  toggleFallbackTriggerError: (value: string) => void;
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
  addAgent,
  agentInstanceCount,
  removeParticipantInstance,
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
  goal,
  setGoal,
  constraints,
  setConstraints,
  deliverableType,
  setDeliverableType,
  targetAudience,
  setTargetAudience,
  fallbackMode,
  setFallbackMode,
  preservePinnedModel,
  setPreservePinnedModel,
  fallbackTriggerErrors,
  toggleFallbackTriggerError,
}: FormContentProps) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const constraintInputRef = useRef<HTMLInputElement>(null);
  const [constraintDraft, setConstraintDraft] = useState('');

  const addConstraint = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (!constraints.includes(trimmed)) {
        setConstraints([...constraints, trimmed]);
      }
      setConstraintDraft('');
    },
    [constraints, setConstraints],
  );

  const removeConstraint = useCallback(
    (tag: string) => {
      setConstraints(constraints.filter((c) => c !== tag));
    },
    [constraints, setConstraints],
  );

  const handleConstraintKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addConstraint(constraintDraft);
      } else if (e.key === 'Backspace' && constraintDraft === '' && constraints.length > 0) {
        setConstraints(constraints.slice(0, -1));
      }
    },
    [addConstraint, constraintDraft, constraints, setConstraints],
  );

  const hasSetupValues =
    goal.trim().length > 0 || constraints.length > 0 || targetAudience.trim().length > 0;
  const hasRecoveryOverrides =
    fallbackMode !== undefined ||
    preservePinnedModel !== true ||
    fallbackTriggerErrors.join('|') !== FALLBACK_TRIGGER_ERRORS.join('|');

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

      <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.04] px-3 py-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <Label className="text-xs font-semibold text-sky-200/90">Deliverable Type</Label>
            <p className="text-[11px] text-sky-100/55 leading-relaxed">
              Guides how the brainstorm should shape its synthesis. Default is exploratory, but you
              can clear or change it.
            </p>
          </div>
        </div>
        <Select
          value={deliverableType ?? '__none__'}
          onValueChange={(v) =>
            setDeliverableType(
              v === '__none__' ? undefined : (v as BrainstormConfig['deliverableType']),
            )
          }
        >
          <SelectTrigger className="text-sm border-sky-500/20 bg-black/20">
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            <SelectItem value="decision">Decision</SelectItem>
            <SelectItem value="options_list">Options List</SelectItem>
            <SelectItem value="action_plan">Action Plan</SelectItem>
            <SelectItem value="risk_assessment">Risk Assessment</SelectItem>
            <SelectItem value="exploration">Exploration</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Setup (optional) — collapsible */}
      <div className="rounded-md border border-white/[0.06] overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground/60 hover:text-muted-foreground/80 hover:bg-white/[0.02] transition-colors"
          onClick={() => setSetupOpen((v) => !v)}
          aria-expanded={setupOpen}
        >
          <span className="font-medium">
            Setup <span className="text-muted-foreground/35 font-normal">(optional)</span>
            {hasSetupValues && !setupOpen && (
              <span className="ml-1.5 inline-flex items-center rounded-full bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-blue-400">
                configured
              </span>
            )}
          </span>
          {setupOpen ? (
            <ChevronUp className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
        </button>

        {setupOpen && (
          <div className="px-3 pb-3 pt-1 space-y-3 border-t border-white/[0.06]">
            {/* Goal */}
            <div className="space-y-1.5">
              <Label htmlFor="brainstorm-goal" className="text-xs font-medium text-foreground/70">
                Goal
              </Label>
              <Textarea
                dir="auto"
                id="brainstorm-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="What should the outcome be?"
                rows={2}
                className="text-sm resize-none"
              />
            </div>

            {/* Constraints tag input */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-foreground/70">Constraints</Label>
              <div
                className="flex flex-wrap gap-1.5 min-h-[36px] rounded-md border border-input bg-transparent px-3 py-1.5 text-sm cursor-text focus-within:ring-1 focus-within:ring-ring"
                onClick={() => constraintInputRef.current?.focus()}
              >
                {constraints.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-white/[0.08] px-2 py-0.5 text-[11px] text-foreground/80"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeConstraint(tag);
                      }}
                      className="text-muted-foreground/50 hover:text-foreground/80 transition-colors"
                      aria-label={`Remove ${tag}`}
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}
                <input
                  ref={constraintInputRef}
                  value={constraintDraft}
                  onChange={(e) => setConstraintDraft(e.target.value)}
                  onKeyDown={handleConstraintKeyDown}
                  onBlur={() => addConstraint(constraintDraft)}
                  placeholder={constraints.length === 0 ? 'Type and press Enter or comma...' : ''}
                  className="flex-1 min-w-[120px] bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/35"
                />
              </div>
              <p className="text-[10px] text-muted-foreground/35">
                e.g. &quot;must use TypeScript&quot;, &quot;no breaking changes&quot;
              </p>
            </div>

            {/* Target audience */}
            <div className="space-y-1.5">
              <Label
                htmlFor="brainstorm-audience"
                className="text-xs font-medium text-foreground/70"
              >
                Target Audience
              </Label>
              <Input
                dir="auto"
                id="brainstorm-audience"
                value={targetAudience}
                onChange={(e) => setTargetAudience(e.target.value)}
                placeholder="Who will use the output?"
                className="text-sm"
              />
            </div>
          </div>
        )}
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

      <div className="rounded-md border border-white/[0.06] overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground/60 hover:text-muted-foreground/80 hover:bg-white/[0.02] transition-colors"
          onClick={() => setRecoveryOpen((v) => !v)}
          aria-expanded={recoveryOpen}
        >
          <span className="font-medium">
            Recovery <span className="text-muted-foreground/35 font-normal">(optional)</span>
            {hasRecoveryOverrides && !recoveryOpen && (
              <span className="ml-1.5 inline-flex items-center rounded-full bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-blue-400">
                configured
              </span>
            )}
          </span>
          {recoveryOpen ? (
            <ChevronUp className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
        </button>

        {recoveryOpen && (
          <div className="px-3 pb-3 pt-1 space-y-3 border-t border-white/[0.06]">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-foreground/70">Fallback Mode</Label>
              <Select
                value={fallbackMode ?? '__default__'}
                onValueChange={(value) =>
                  setFallbackMode(
                    value === '__default__'
                      ? undefined
                      : (value as NonNullable<BrainstormConfig['fallback']>['mode']),
                  )
                }
              >
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="Default: model then agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Default</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="model_only">Model only</SelectItem>
                  <SelectItem value="model_then_agent">Model then agent</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground/35">
                Controls whether participants should recover automatically from explicit provider,
                model, or authentication failures.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-foreground/70">Trigger Errors</Label>
              <div className="space-y-2">
                {[
                  { value: 'usage_limit', label: 'Usage limit' },
                  { value: 'auth_error', label: 'Authentication failure' },
                  { value: 'provider_unavailable', label: 'Provider unavailable' },
                  { value: 'model_unavailable', label: 'Model unavailable' },
                  { value: 'rate_limited', label: 'Rate limited' },
                ].map((option) => (
                  <label
                    key={option.value}
                    className="flex items-center gap-2 text-xs text-foreground/75"
                  >
                    <Checkbox
                      checked={fallbackTriggerErrors.includes(option.value)}
                      onCheckedChange={() => toggleFallbackTriggerError(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/35">
                Defaults target explicit non-recoverable failures. Rate-limit fallback is opt-in.
              </p>
            </div>

            <label className="flex items-center gap-2 text-xs text-foreground/75">
              <Checkbox
                checked={preservePinnedModel}
                onCheckedChange={(checked) => setPreservePinnedModel(checked === true)}
              />
              <span>Keep explicitly selected participant models pinned</span>
            </label>
          </div>
        )}
      </div>

      <SectionHeader>Participants</SectionHeader>

      {/* Participants — agent catalog + selected instances */}
      <div className="space-y-3">
        {/* Agent catalog: click to add an instance */}
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
          <div className="flex flex-wrap gap-1.5">
            {agents.map((agent, agentIndex) => {
              const count = agentInstanceCount(agent.id);
              const colors = getAgentColor(agent.slug, agentIndex);
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => addAgent(agent)}
                  className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-all hover:bg-white/[0.04] active:scale-95 ${
                    count > 0
                      ? `${colors.border.replace('border-l-', 'border-')} bg-white/[0.02]`
                      : 'border-white/[0.08] bg-white/[0.01]'
                  }`}
                >
                  <Plus className="size-3 text-muted-foreground/50 group-hover:text-foreground/70 transition-colors" />
                  <AgentAvatar name={agent.name} slug={agent.slug} index={agentIndex} size="xs" />
                  <span className="text-foreground/70">{agent.name}</span>
                  {count > 0 && (
                    <span className="text-[9px] font-mono text-muted-foreground/50 bg-white/[0.04] rounded-full px-1.5 min-w-[18px] text-center">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Selected participants list */}
        {participants.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">
                Roster
              </span>
              <span className="text-[10px] text-muted-foreground/40">
                {participants.length} participant{participants.length !== 1 ? 's' : ''}{' '}
                {participants.length < 2 && '· need at least 2'}
              </span>
            </div>
            <div className="space-y-1">
              {participants.map((participant) => {
                const agentIndex = agents.findIndex((a) => a.id === participant.agentId);
                const agent = agents[agentIndex];
                const colors = getAgentColor(participant.agentSlug, agentIndex);
                const borderColorClass = colors.border.replace('border-l-', 'border-l-');
                const sameAgentInstances = participants.filter(
                  (p) => p.agentId === participant.agentId,
                );
                const instanceNumber =
                  sameAgentInstances.length > 1
                    ? sameAgentInstances.findIndex((p) => p.instanceId === participant.instanceId) +
                      1
                    : 0;

                return (
                  <div
                    key={participant.instanceId}
                    className={`rounded-lg border-l-2 ${borderColorClass} border border-white/[0.06] bg-white/[0.015] transition-colors`}
                  >
                    <div className="flex items-center gap-2 px-2.5 py-1.5">
                      <AgentAvatar
                        name={participant.agentName}
                        slug={participant.agentSlug}
                        index={agentIndex}
                        size="xs"
                      />
                      <span className="text-xs text-foreground/75 flex-1">
                        {participant.agentName}
                        {instanceNumber > 0 && (
                          <span className="text-muted-foreground/40 ms-1">#{instanceNumber}</span>
                        )}
                      </span>

                      {/* Inline model selector */}
                      {agent && (
                        <div
                          className="flex items-center gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {(() => {
                            const provider = deriveProvider(agent.binaryPath);
                            const models = modelsByProvider[provider] ?? [];
                            const isLoading = loadingProviders.has(provider);

                            if (isLoading) {
                              return (
                                <Loader2 className="size-3 animate-spin text-muted-foreground/30" />
                              );
                            }

                            return (
                              <Select
                                value={participant.model || '__default__'}
                                onValueChange={(v) =>
                                  setParticipantModel(
                                    participant.instanceId,
                                    v === '__default__' ? '' : v,
                                  )
                                }
                              >
                                <SelectTrigger className="h-6 text-[10px] w-[130px] border-white/[0.06] bg-transparent px-2">
                                  <SelectValue placeholder="Default" />
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

                      <button
                        type="button"
                        onClick={() => removeParticipantInstance(participant.instanceId)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground/30 hover:text-foreground/60 hover:bg-white/[0.05] transition-colors"
                        aria-label={`Remove ${participant.agentName}`}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
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

  // Setup / goal fields
  const [goal, setGoal] = useState('');
  const [constraints, setConstraints] = useState<string[]>([]);
  const [deliverableType, setDeliverableType] =
    useState<BrainstormConfig['deliverableType']>(DEFAULT_DELIVERABLE_TYPE);
  const [targetAudience, setTargetAudience] = useState('');
  const [fallbackMode, setFallbackMode] =
    useState<NonNullable<BrainstormConfig['fallback']>['mode']>(undefined);
  const [preservePinnedModel, setPreservePinnedModel] = useState(true);
  const [fallbackTriggerErrors, setFallbackTriggerErrors] = useState<string[]>([
    ...FALLBACK_TRIGGER_ERRORS,
  ]);

  // Draft persistence via existing useDraft hook (debounced localStorage)
  const { saveDraft, getDraft, clearDraft } = useDraft('draft:brainstorm:new');

  /** Save current form state as draft (called on every field change) */
  const persistDraft = useCallback(() => {
    if (!title && !topic) return;
    const draftConfig: BrainstormConfig = { ...config };
    const hasCustomFallbackTriggers =
      fallbackTriggerErrors.length !== FALLBACK_TRIGGER_ERRORS.length ||
      fallbackTriggerErrors.some((value, index) => value !== FALLBACK_TRIGGER_ERRORS[index]);
    if (fallbackMode !== undefined || preservePinnedModel !== true || hasCustomFallbackTriggers) {
      draftConfig.fallback = {
        mode: fallbackMode,
        preservePinnedModel,
        triggerErrors: fallbackTriggerErrors as NonNullable<
          BrainstormConfig['fallback']
        >['triggerErrors'],
      };
    }
    const draft: DraftState = {
      title,
      topic,
      selectedProjectId,
      maxWaves,
      presetId,
      config: draftConfig,
      goal: goal || undefined,
      constraints: constraints.length > 0 ? constraints : undefined,
      deliverableType,
      targetAudience: targetAudience || undefined,
    };
    saveDraft(JSON.stringify(draft));
  }, [
    title,
    topic,
    selectedProjectId,
    maxWaves,
    presetId,
    config,
    fallbackMode,
    fallbackTriggerErrors,
    goal,
    constraints,
    deliverableType,
    preservePinnedModel,
    targetAudience,
    saveDraft,
  ]);

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
      if (draft.goal) setGoal(draft.goal);
      if (draft.constraints) setConstraints(draft.constraints);
      setDeliverableType(draft.deliverableType ?? DEFAULT_DELIVERABLE_TYPE);
      if (draft.targetAudience) setTargetAudience(draft.targetAudience);
      if (draft.config?.fallback?.mode !== undefined) {
        setFallbackMode(draft.config.fallback.mode);
      }
      setPreservePinnedModel(draft.config?.fallback?.preservePinnedModel ?? true);
      setFallbackTriggerErrors(
        draft.config?.fallback?.triggerErrors ?? [...FALLBACK_TRIGGER_ERRORS],
      );
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

  const agentInstanceCount = useCallback(
    (agentId: string) => participants.filter((p) => p.agentId === agentId).length,
    [participants],
  );

  const addAgent = useCallback(
    (agent: AgentOption) => {
      // Fetch models for this agent's provider
      const provider = deriveProvider(agent.binaryPath);
      void fetchModelsForProvider(provider);
      setParticipants((prev) => [
        ...prev,
        {
          instanceId: nextInstanceId(),
          agentId: agent.id,
          agentName: agent.name,
          agentSlug: agent.slug,
          model: '',
        },
      ]);
    },
    [fetchModelsForProvider],
  );

  const removeParticipantInstance = useCallback((instanceId: string) => {
    setParticipants((prev) => prev.filter((p) => p.instanceId !== instanceId));
  }, []);

  const setParticipantModel = useCallback((instanceId: string, model: string) => {
    setParticipants((prev) => prev.map((p) => (p.instanceId === instanceId ? { ...p, model } : p)));
  }, []);

  const toggleFallbackTriggerError = useCallback((value: string) => {
    setFallbackTriggerErrors((prev) =>
      prev.includes(value) ? prev.filter((entry) => entry !== value) : [...prev, value],
    );
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
      // Merge relatedRoomIds and setup fields into config
      const finalConfig: BrainstormConfig = { ...config };
      if (selectedRelatedIds.length > 0) {
        finalConfig.relatedRoomIds = selectedRelatedIds;
      }
      if (goal.trim()) finalConfig.goal = goal.trim();
      if (constraints.length > 0) finalConfig.constraints = constraints;
      if (deliverableType) finalConfig.deliverableType = deliverableType;
      if (targetAudience.trim()) finalConfig.targetAudience = targetAudience.trim();
      const hasCustomFallbackTriggers =
        fallbackTriggerErrors.length !== FALLBACK_TRIGGER_ERRORS.length ||
        fallbackTriggerErrors.some((value, index) => value !== FALLBACK_TRIGGER_ERRORS[index]);
      if (fallbackMode !== undefined || preservePinnedModel !== true || hasCustomFallbackTriggers) {
        finalConfig.fallback = {
          mode: fallbackMode,
          preservePinnedModel,
          triggerErrors: fallbackTriggerErrors as NonNullable<
            BrainstormConfig['fallback']
          >['triggerErrors'],
        };
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
      setGoal('');
      setConstraints([]);
      setDeliverableType(DEFAULT_DELIVERABLE_TYPE);
      setTargetAudience('');
      setFallbackMode(undefined);
      setPreservePinnedModel(true);
      setFallbackTriggerErrors([...FALLBACK_TRIGGER_ERRORS]);

      onOpenChange(false);
      router.push(`/brainstorms/${room.id}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    clearDraft,
    config,
    constraints,
    deliverableType,
    fallbackMode,
    fallbackTriggerErrors,
    goal,
    projectId,
    preservePinnedModel,
    selectedProjectId,
    selectedRelatedIds,
    targetAudience,
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
    addAgent,
    agentInstanceCount,
    removeParticipantInstance,
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
    goal,
    setGoal,
    constraints,
    setConstraints,
    deliverableType,
    setDeliverableType,
    targetAudience,
    setTargetAudience,
    fallbackMode,
    setFallbackMode,
    preservePinnedModel,
    setPreservePinnedModel,
    fallbackTriggerErrors,
    toggleFallbackTriggerError,
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
