'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Loader2, Bot } from 'lucide-react';
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
import type { Agent, AgentCapability } from '@/lib/types';
import type { SessionStatus } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentWithCapabilities extends Agent {
  capabilities: AgentCapability[];
}

interface AgentsApiResponse {
  data: AgentWithCapabilities[];
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

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
}

export function PlanConversationPanel({
  planId,
  currentContent,
  conversationSessionId,
  onContentChange,
  onClose,
  onSessionCreated,
}: PlanConversationPanelProps) {
  // Agent picker state
  const [agents, setAgents] = useState<AgentWithCapabilities[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(!conversationSessionId);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Edit state: maps edit id -> 'applied' | 'skipped'
  // Persisted to localStorage so it survives page refreshes.
  // typeof window guard ensures this is skipped during SSR.
  const [editStates, setEditStates] = useState<Record<string, 'applied' | 'skipped'>>(() => {
    if (typeof window === 'undefined' || !conversationSessionId) return {};
    try {
      const stored = localStorage.getItem(`plan-edits-${conversationSessionId}`);
      return stored ? (JSON.parse(stored) as Record<string, 'applied' | 'skipped'>) : {};
    } catch {
      return {};
    }
  });

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
      isConnected: stream.isConnected,
      error: stream.error,
      reset: stream.reset,
    }),
    [stream.events, stream.sessionStatus, stream.isConnected, stream.error, stream.reset],
  );

  const currentStatus = stream.sessionStatus as SessionStatus | null;

  // Extract init event for slash commands / MCP servers
  const initEvent = stream.events
    .filter((e): e is Extract<typeof e, { type: 'session:init' }> => e.type === 'session:init')
    .at(-1);
  const slashCommands = initEvent?.slashCommands;
  const mcpServers = initEvent?.mcpServers;

  // Extract plan edits from streamed events
  const planEdits = useMemo(() => extractPlanEdits(stream.events), [stream.events]);

  // Fetch agents on mount if no active session
  useEffect(() => {
    if (conversationSessionId) return;

    let cancelled = false;

    void apiFetch<AgentsApiResponse>('/api/agents?capabilities=true&group=ai')
      .then((res) => {
        if (cancelled) return;
        const promptAgents = res.data.filter((a) =>
          a.capabilities?.some((cap) => cap.interactionMode === 'prompt'),
        );
        setAgents(promptAgents);
        setLoadingAgents(false);
        if (promptAgents.length > 0) {
          setSelectedAgentId(promptAgents[0].id);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAgentError(err instanceof Error ? err.message : 'Failed to load agents');
        setLoadingAgents(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationSessionId]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const selectedCapability = selectedAgent?.capabilities.find(
    (cap) => cap.interactionMode === 'prompt',
  );

  const handleStartConversation = useCallback(async () => {
    if (!selectedCapability || isStarting) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const result = await apiFetch<ApiResponse<{ sessionId: string }>>(
        `/api/plans/${planId}/conversation`,
        {
          method: 'POST',
          body: JSON.stringify({
            agentId: selectedAgentId,
            capabilityId: selectedCapability.id,
          }),
        },
      );
      onSessionCreated(result.data.sessionId);
    } catch (err: unknown) {
      setStartError(err instanceof Error ? err.message : 'Failed to start conversation');
      setIsStarting(false);
    }
  }, [selectedCapability, selectedAgentId, planId, isStarting, onSessionCreated]);

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

  // Pending edits not yet acted on
  const pendingEdits = planEdits.filter((edit) => !editStates[edit.id]);

  return (
    <div className="flex flex-col h-full bg-[oklch(0.085_0.005_240)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] shrink-0">
        <span className="text-sm font-medium text-foreground/80">Plan Chat</span>
        {conversationSessionId && <StatusDot status={currentStatus} />}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors rounded-md p-0.5 hover:bg-white/[0.05]"
          aria-label="Close plan chat"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {!conversationSessionId ? (
          /* Agent picker */
          <div className="flex flex-col gap-4 p-4">
            <p className="text-xs text-muted-foreground/60">
              Start a conversation with an AI agent about this plan. The agent can suggest edits
              using the <code className="bg-white/[0.06] px-1 rounded text-[10px]">PLAN_EDIT</code>{' '}
              marker.
            </p>

            {agentError && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {agentError}
              </p>
            )}

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground/70 font-medium">Agent</label>
              {loadingAgents ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                  <Loader2 className="size-3 animate-spin" />
                  Loading agents...
                </div>
              ) : agents.length === 0 ? (
                <p className="text-xs text-muted-foreground/50">
                  No agents with prompt capabilities found.
                </p>
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

            {startError && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {startError}
              </p>
            )}

            <Button
              size="sm"
              onClick={() => void handleStartConversation()}
              disabled={isStarting || !selectedCapability}
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
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SessionChatView
                sessionId={conversationSessionId}
                stream={adaptedStream}
                currentStatus={currentStatus}
                compact={true}
              />
            </div>

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
              mcpServers={mcpServers}
            />
          </div>
        )}
      </div>
    </div>
  );
}
