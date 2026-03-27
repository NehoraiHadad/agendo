'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useFetch } from '@/hooks/use-fetch';
import {
  X,
  Loader2,
  Bot,
  Square,
  Plus,
  Cpu,
  PowerOff,
  Shield,
  ShieldCheck,
  ShieldOff,
  BookOpen,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { SessionChatView } from '@/components/sessions/session-chat-view';
import { SessionMessageInput } from '@/components/sessions/session-message-input';
import { PlanDiffCard } from '@/components/plans/plan-diff-card';
import { useSessionStream } from '@/hooks/use-session-stream';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { extractPlanEdits } from '@/lib/utils/plan-edit-parser';
import type { Agent } from '@/lib/types';
import type { SessionStatus } from '@/lib/realtime/events';
import {
  getLatestContextStats,
  fmtTokens,
  fmtPct,
  ctxBarWidth,
  ctxBarColor,
  ctxTrackColor,
} from '@/lib/utils/context-stats';
import {
  type PermissionMode,
  type ModeConfigEntry,
  type DynamicModelOption,
  nextMode as getNextMode,
  modelDisplayLabel,
  deriveProvider,
} from '@/lib/utils/session-controls';
import { getErrorMessage } from '@/lib/utils/error-utils';
import { ErrorAlert } from '@/components/ui/error-alert';

// ---------------------------------------------------------------------------
// Mode config (icon references are component-level)
// ---------------------------------------------------------------------------

const MODE_CONFIG: Record<PermissionMode, ModeConfigEntry> = {
  plan: {
    label: 'Plan',
    icon: BookOpen,
    className: 'text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 border-violet-500/20',
    title: 'Plan mode (read-only). Click to cycle.',
  },
  default: {
    label: 'Approve',
    icon: Shield,
    className: 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border-amber-500/20',
    title: 'Approve mode. Click to cycle.',
  },
  acceptEdits: {
    label: 'Edit Only',
    icon: ShieldCheck,
    className: 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 border-blue-500/20',
    title: 'Edit-only mode. Click to cycle.',
  },
  bypassPermissions: {
    label: 'Auto',
    icon: ShieldOff,
    className:
      'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 border-emerald-500/20',
    title: 'Auto mode. Click to cycle.',
  },
  dontAsk: {
    label: 'Auto',
    icon: ShieldOff,
    className:
      'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 border-emerald-500/20',
    title: 'Auto mode. Click to cycle.',
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentsApiResponse {
  data: Agent[];
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

/** Stable no-op for history loading (plan panels don't support scroll-back). */
const noopLoadOlder = async () => false;

function StatusDot({ status }: { status: SessionStatus | null }) {
  if (!status) return null;

  let colorClass: string;
  switch (status) {
    case 'active':
      colorClass = 'bg-amber-400 shadow-[0_0_6px_oklch(0.78_0.17_65/0.6)]';
      break;
    case 'awaiting_input':
      colorClass = 'bg-emerald-400 shadow-[0_0_6px_oklch(0.7_0.18_150/0.6)]';
      break;
    case 'ended':
      colorClass = 'bg-zinc-500';
      break;
    default:
      colorClass = 'bg-zinc-600';
  }

  return <span className={`inline-block size-1.5 rounded-full shrink-0 ${colorClass}`} />;
}

// ---------------------------------------------------------------------------
// PlanConversationPanel
// ---------------------------------------------------------------------------

interface PlanConversationPanelProps {
  planId: string;
  currentContent: string;
  conversationSessionId: string | null;
  onContentChange: (newContent: string) => void;
  onClose: () => void;
  onSessionCreated: (sessionId: string) => void;
  onNewChat: () => void;
}

// ---------------------------------------------------------------------------
// PlanStopButton — soft interrupt for plan conversation panel
// ---------------------------------------------------------------------------

function PlanStopButton({ sessionId }: { sessionId: string }) {
  const [isInterrupting, setIsInterrupting] = useState(false);

  const handleInterrupt = useCallback(async () => {
    if (isInterrupting) return;
    setIsInterrupting(true);
    try {
      await fetch(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
    } finally {
      setIsInterrupting(false);
    }
  }, [sessionId, isInterrupting]);

  return (
    <button
      type="button"
      onClick={() => void handleInterrupt()}
      disabled={isInterrupting}
      className="flex items-center gap-1.5 text-xs text-amber-400/70 hover:text-amber-300 hover:bg-amber-500/10 border border-amber-500/15 hover:border-amber-500/30 rounded-md px-3 py-1 transition-colors disabled:opacity-40"
      aria-label="Stop current agent action"
    >
      {isInterrupting ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Square className="size-3 fill-current" />
      )}
      Stop
    </button>
  );
}

export function PlanConversationPanel({
  planId,
  currentContent,
  conversationSessionId,
  onContentChange,
  onClose,
  onSessionCreated,
  onNewChat,
}: PlanConversationPanelProps) {
  // Agent picker state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(!conversationSessionId);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Edit state: maps edit id -> 'applied' | 'skipped'
  // Persisted to localStorage so it survives page refreshes.
  const [editStates, setEditStates] = useState<Record<string, 'applied' | 'skipped'>>({});

  // Load persisted edit states from localStorage when conversationSessionId is available.
  // setState lives inside .then() to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!conversationSessionId) return;
    void Promise.resolve().then(() => {
      try {
        const stored = localStorage.getItem(`plan-edits-${conversationSessionId}`);
        if (stored) {
          setEditStates(JSON.parse(stored) as Record<string, 'applied' | 'skipped'>);
        }
      } catch {
        // localStorage unavailable
      }
    });
  }, [conversationSessionId]);

  const persistEditState = useCallback(
    (editId: string, state: 'applied' | 'skipped') => {
      setEditStates((prev) => ({ ...prev, [editId]: state }));
      if (typeof window === 'undefined' || !conversationSessionId) return;
      try {
        const raw = localStorage.getItem(`plan-edits-${conversationSessionId}`) ?? '{}';
        const current = JSON.parse(raw) as Record<string, 'applied' | 'skipped'>;
        localStorage.setItem(
          `plan-edits-${conversationSessionId}`,
          JSON.stringify({ ...current, [editId]: state }),
        );
      } catch {
        // localStorage unavailable
      }
    },
    [conversationSessionId],
  );

  // Session stream
  const stream = useSessionStream(conversationSessionId);

  // Adapted stream shape matching UseSessionStreamReturn
  const adaptedStream = useMemo(
    () => ({
      events: stream.events,
      sessionStatus: stream.sessionStatus,
      permissionMode: stream.permissionMode,
      isConnected: stream.isConnected,
      error: stream.error,
      reset: stream.reset,
      loadOlderHistory: noopLoadOlder,
      hasOlderHistory: false,
      isLoadingOlderHistory: false,
    }),
    [
      stream.events,
      stream.sessionStatus,
      stream.permissionMode,
      stream.isConnected,
      stream.error,
      stream.reset,
    ],
  );

  const currentStatus = stream.sessionStatus as SessionStatus | null;

  // Extract init event for slash commands / MCP servers
  const initEvent = stream.events
    .filter((e): e is Extract<typeof e, { type: 'session:init' }> => e.type === 'session:init')
    .at(-1);
  const slashCommands = initEvent?.slashCommands;
  const mcpServers = initEvent?.mcpServers;

  // Rich command metadata from session:commands event (emitted by SDK adapter after init)
  const richSlashCommands = stream.events
    .filter(
      (e): e is Extract<typeof e, { type: 'session:commands' }> => e.type === 'session:commands',
    )
    .at(-1)?.slashCommands;

  // Extract plan edits from streamed events
  const planEdits = useMemo(() => extractPlanEdits(stream.events), [stream.events]);

  // Context window stats from latest agent:result
  const contextStats = useMemo(() => getLatestContextStats(stream.events), [stream.events]);

  // Fetch agents on mount if no active session
  useEffect(() => {
    if (conversationSessionId) return;

    let cancelled = false;

    void apiFetch<AgentsApiResponse>('/api/agents?group=ai')
      .then((res) => {
        if (cancelled) return;
        const activeAgents = res.data.filter((a) => a.isActive);
        setAgents(activeAgents);
        setLoadingAgents(false);
        if (activeAgents.length > 0) {
          setSelectedAgentId(activeAgents[0].id);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAgentError(getErrorMessage(err));
        setLoadingAgents(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationSessionId]);

  const handleStartConversation = useCallback(async () => {
    if (!selectedAgentId || isStarting) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const result = await apiFetch<ApiResponse<{ sessionId: string }>>(
        `/api/plans/${planId}/conversation`,
        {
          method: 'POST',
          body: JSON.stringify({
            agentId: selectedAgentId,
          }),
        },
      );
      onSessionCreated(result.data.sessionId);
    } catch (err: unknown) {
      setStartError(getErrorMessage(err));
      setIsStarting(false);
    }
  }, [selectedAgentId, planId, isStarting, onSessionCreated]);

  const handleApply = useCallback(
    (editId: string, newContent: string) => {
      persistEditState(editId, 'applied');
      onContentChange(newContent);
    },
    [persistEditState, onContentChange],
  );

  const handleSkip = useCallback(
    (editId: string) => {
      persistEditState(editId, 'skipped');
    },
    [persistEditState],
  );

  const [isStartingNew, setIsStartingNew] = useState(false);

  const handleNewChat = useCallback(async () => {
    if (isStartingNew) return;
    setIsStartingNew(true);
    try {
      await apiFetch(`/api/plans/${planId}`, {
        method: 'PATCH',
        body: JSON.stringify({ conversationSessionId: null }),
      });
      onNewChat();
    } finally {
      setIsStartingNew(false);
    }
  }, [planId, isStartingNew, onNewChat]);

  // ---------------------------------------------------------------------------
  // Session controls: model, permission mode, end session
  // ---------------------------------------------------------------------------

  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    (initEvent?.permissionMode as PermissionMode) ?? 'plan',
  );
  const [isModeChanging, setIsModeChanging] = useState(false);
  const [isModelChanging, setIsModelChanging] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [dynamicModels, setDynamicModels] = useState<DynamicModelOption[]>([]);
  const [isEnding, setIsEnding] = useState(false);

  // Sync permissionMode when init event arrives
  useEffect(() => {
    if (initEvent?.permissionMode) {
      setPermissionMode(initEvent.permissionMode as PermissionMode);
    }
  }, [initEvent?.permissionMode]);

  // Close model menu on outside click
  useEffect(() => {
    if (!showModelMenu) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelMenu]);

  // Fetch available models from the agent's provider
  const modelProvider = useMemo(() => {
    if (!initEvent?.cwd) return null;
    const selectedAgent = agents.find((a) => a.id === selectedAgentId);
    return selectedAgent?.binaryPath ? deriveProvider(selectedAgent.binaryPath) : 'claude';
  }, [initEvent?.cwd, selectedAgentId, agents]);

  const { data: fetchedModels } = useFetch<DynamicModelOption[]>(
    modelProvider ? `/api/models?provider=${encodeURIComponent(modelProvider)}` : null,
    {
      deps: [modelProvider],
      transform: (json: unknown) =>
        ((json as { data: DynamicModelOption[] })?.data ?? []).map((m) => ({
          id: m.id,
          label: m.label,
        })),
    },
  );

  useEffect(() => {
    if (fetchedModels) setDynamicModels(fetchedModels);
  }, [fetchedModels]);

  // Derive current model from stream events (same logic as session-detail-client)
  const events = stream.events;
  const lastModelInfoEvent = useMemo(
    () =>
      [...events]
        .reverse()
        .find(
          (e) =>
            e.type === 'system:info' &&
            (e as Extract<typeof e, { type: 'system:info' }>).message.startsWith(
              'Model switched to',
            ),
        ) as Extract<(typeof events)[number], { type: 'system:info' }> | undefined,
    [events],
  );
  const modelFromInfo = lastModelInfoEvent
    ? (lastModelInfoEvent.message.match(/Model switched to "(.+)"/)?.[1] ?? null)
    : null;
  const currentModel = modelFromInfo ?? initEvent?.model ?? null;
  const modelLabel = currentModel ? modelDisplayLabel(currentModel) : null;

  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (isModelChanging || !conversationSessionId || currentStatus === 'ended') return;
      setIsModelChanging(true);
      setShowModelMenu(false);
      try {
        await fetch(`/api/sessions/${conversationSessionId}/model`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: modelId }),
        });
      } finally {
        setIsModelChanging(false);
      }
    },
    [isModelChanging, conversationSessionId, currentStatus],
  );

  const handleModeChange = useCallback(async () => {
    if (isModeChanging || !conversationSessionId || currentStatus === 'ended') return;
    const target = getNextMode(permissionMode);
    setIsModeChanging(true);
    try {
      const res = await fetch(`/api/sessions/${conversationSessionId}/mode`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: target }),
      });
      if (res.ok) setPermissionMode(target);
    } finally {
      setIsModeChanging(false);
    }
  }, [isModeChanging, conversationSessionId, currentStatus, permissionMode]);

  const handleEndSession = useCallback(async () => {
    if (isEnding || !conversationSessionId) return;
    setIsEnding(true);
    try {
      await fetch(`/api/sessions/${conversationSessionId}/cancel`, { method: 'POST' });
    } finally {
      setIsEnding(false);
    }
  }, [isEnding, conversationSessionId]);

  const modeCfg = MODE_CONFIG[permissionMode];
  const ModeIcon = modeCfg.icon;

  // Pending edits not yet acted on
  const pendingEdits = planEdits.filter((edit) => !editStates[edit.id]);

  return (
    <div className="flex flex-col h-full bg-[oklch(0.085_0.005_240)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] shrink-0">
        <span className="text-sm font-medium text-foreground/80">Plan Chat</span>
        {conversationSessionId && <StatusDot status={currentStatus} />}
        {contextStats && (
          <span
            className="inline-flex items-center gap-1.5 ml-1"
            title={
              contextStats.contextWindow
                ? `Context: ${contextStats.inputTokens.toLocaleString()} / ${contextStats.contextWindow.toLocaleString()} tokens (${fmtPct(contextStats.inputTokens / contextStats.contextWindow)} full)`
                : `Context: ${contextStats.inputTokens.toLocaleString()} tokens used`
            }
          >
            {contextStats.contextWindow && (
              <span
                className="relative inline-block h-[4px] w-10 rounded-full overflow-hidden shrink-0"
                style={{
                  backgroundColor: ctxTrackColor(
                    contextStats.inputTokens / contextStats.contextWindow,
                  ),
                }}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full transition-[width]"
                  style={{
                    width: ctxBarWidth(contextStats.inputTokens / contextStats.contextWindow),
                    backgroundColor: ctxBarColor(
                      contextStats.inputTokens / contextStats.contextWindow,
                    ),
                  }}
                />
              </span>
            )}
            <span className="text-muted-foreground/50 font-mono text-[10px]">
              {fmtTokens(contextStats.inputTokens)}
              {contextStats.contextWindow ? `/${fmtTokens(contextStats.contextWindow)}` : ''}
            </span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {conversationSessionId && (
            <button
              type="button"
              onClick={() => void handleNewChat()}
              disabled={isStartingNew}
              className="text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors rounded-md p-0.5 hover:bg-white/[0.05] disabled:opacity-40"
              aria-label="Start new chat"
              title="New chat"
            >
              {isStartingNew ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors rounded-md p-0.5 hover:bg-white/[0.05]"
            aria-label="Close plan chat"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Session controls toolbar — compact strip below header */}
      {conversationSessionId && currentStatus !== 'ended' && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-white/[0.04] shrink-0">
          {/* Model selector */}
          <div className="relative" ref={modelMenuRef}>
            <button
              type="button"
              onClick={() => setShowModelMenu((v) => !v)}
              disabled={isModelChanging}
              title={currentModel ? `Model: ${currentModel}` : 'Select model'}
              className="flex items-center gap-1 text-[11px] text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/10 border border-cyan-500/15 rounded-md px-1.5 py-0.5 transition-colors disabled:opacity-40"
            >
              {isModelChanging ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Cpu className="size-3" />
              )}
              <span className="max-w-[80px] truncate">{modelLabel ?? 'Model'}</span>
            </button>
            {showModelMenu && (
              <div className="absolute top-full left-0 mt-1 z-50 min-w-[160px] rounded-lg border border-white/[0.1] bg-[oklch(0.12_0.005_240)] shadow-xl p-1">
                {dynamicModels.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground/40 px-2 py-1.5">
                    No models available
                  </p>
                ) : (
                  dynamicModels.map((m) => {
                    const isActive = currentModel?.toLowerCase() === m.id.toLowerCase();
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => void handleModelChange(m.id)}
                        className={`w-full text-left px-2 py-1.5 text-[11px] rounded-md transition-colors hover:bg-white/[0.07] ${isActive ? 'text-cyan-400 font-medium' : 'text-foreground/70'}`}
                      >
                        {isActive && <span className="mr-1">&#10003;</span>}
                        {m.label}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Permission mode */}
          <button
            type="button"
            onClick={() => void handleModeChange()}
            disabled={isModeChanging}
            title={modeCfg.title}
            className={`flex items-center gap-1 text-[11px] border rounded-md px-1.5 py-0.5 transition-all disabled:opacity-40 ${modeCfg.className}`}
          >
            {isModeChanging ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ModeIcon className="size-3" />
            )}
            <span>{modeCfg.label}</span>
          </button>

          {/* End session */}
          <button
            type="button"
            onClick={() => void handleEndSession()}
            disabled={isEnding}
            title="End session"
            className="ml-auto flex items-center gap-1 text-[11px] text-red-400/60 hover:text-red-300 hover:bg-red-500/10 border border-red-500/15 rounded-md px-1.5 py-0.5 transition-colors disabled:opacity-40"
          >
            {isEnding ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <PowerOff className="size-3" />
            )}
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {!conversationSessionId ? (
          /* Agent picker */
          <div className="flex flex-col gap-4 p-4">
            <p className="text-xs text-muted-foreground/60">
              Start a plan conversation with an AI agent. The agent will review the codebase in{' '}
              <strong className="text-foreground/70">plan mode</strong> (read-only) and finalize the
              plan via ExitPlanMode when ready.
            </p>

            <ErrorAlert message={agentError} />

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground/70 font-medium">Agent</label>
              {loadingAgents ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                  <Loader2 className="size-3 animate-spin" />
                  Loading agents...
                </div>
              ) : agents.length === 0 ? (
                <p className="text-xs text-muted-foreground/50">No active agents found.</p>
              ) : (
                <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                  <SelectTrigger className="w-full border-white/[0.08] bg-white/[0.04]">
                    <div className="flex items-center gap-2">
                      <Bot className="size-3 text-muted-foreground/50 shrink-0" />
                      <SelectValue placeholder="Select agent" />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <ErrorAlert message={startError} />

            <Button
              size="sm"
              onClick={() => void handleStartConversation()}
              disabled={isStarting || !selectedAgentId}
              className="gap-1.5 bg-amber-500/15 text-amber-400 border-amber-500/25 hover:bg-amber-500/25 self-start"
            >
              {isStarting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Bot className="size-3" />
              )}
              Start Conversation
            </Button>
          </div>
        ) : (
          /* Active session */
          <div className="flex flex-col flex-1 min-h-0">
            {/* Chat view */}
            <div className="flex flex-col flex-1 min-h-0">
              <SessionChatView
                sessionId={conversationSessionId}
                stream={adaptedStream}
                currentStatus={currentStatus}
                compact={true}
              />
            </div>

            {/* Stop button — only when agent is actively running */}
            {currentStatus === 'active' && (
              <div className="flex justify-center px-3 py-1 border-t border-white/[0.05] shrink-0">
                <PlanStopButton sessionId={conversationSessionId} />
              </div>
            )}

            {/* Pending diff cards */}
            {pendingEdits.length > 0 && (
              <div className="border-t border-amber-500/10 px-3 py-3 space-y-2 shrink-0 max-h-64 overflow-y-auto">
                {planEdits.map((edit) => (
                  <PlanDiffCard
                    key={edit.id}
                    id={edit.id}
                    currentContent={currentContent}
                    suggestedContent={edit.newContent}
                    status={editStates[edit.id] ?? edit.status}
                    onApply={() => handleApply(edit.id, edit.newContent)}
                    onSkip={() => handleSkip(edit.id)}
                  />
                ))}
              </div>
            )}

            {/* Message input */}
            <SessionMessageInput
              sessionId={conversationSessionId}
              status={currentStatus}
              slashCommands={slashCommands}
              richSlashCommands={richSlashCommands}
              mcpServers={mcpServers}
            />
          </div>
        )}
      </div>
    </div>
  );
}
