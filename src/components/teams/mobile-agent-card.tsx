'use client';

import { useState, useCallback } from 'react';
import { Send, Square, Loader2 } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import type { TeamMember } from '@/hooks/use-team-state';
import type { AgentLiveState } from '@/stores/team-monitor-store';
import { apiFetch } from '@/lib/api-types';
import { toast } from 'sonner';

// ── Status config ─────────────────────────────────────────────────────────────

type StatusKey = 'active' | 'awaiting_input' | 'idle' | 'ended' | 'null';

const STATUS_CONFIG: Record<StatusKey, { label: string; badgeClass: string; borderClass: string }> =
  {
    active: {
      label: 'Active',
      badgeClass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      borderClass: 'border-emerald-500/50 shadow-[0_0_12px_rgba(16,185,129,0.2)]',
    },
    awaiting_input: {
      label: 'Waiting',
      badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      borderClass: 'border-amber-500/50 shadow-[0_0_10px_rgba(245,158,11,0.15)]',
    },
    idle: {
      label: 'Idle',
      badgeClass: 'bg-zinc-500/15 text-zinc-500 border-zinc-500/30',
      borderClass: 'border-white/10',
    },
    ended: {
      label: 'Done',
      badgeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
      borderClass: 'border-blue-500/40 shadow-[0_0_8px_rgba(59,130,246,0.15)]',
    },
    null: {
      label: 'Connecting',
      badgeClass: 'bg-zinc-700/30 text-zinc-600 border-zinc-700/30',
      borderClass: 'border-white/[0.06]',
    },
  };

function getStatusConfig(status: string | null) {
  const key = (status ?? 'null') as StatusKey;
  return STATUS_CONFIG[key] ?? STATUS_CONFIG['idle'];
}

// ── Tool history row ──────────────────────────────────────────────────────────

function ToolHistoryRow({ toolName, durationMs }: { toolName: string; durationMs?: number }) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06]">
      <span className="text-[11px] text-amber-400 font-mono truncate">🔧 {toolName}</span>
      {durationMs !== undefined && (
        <span className="text-[10px] text-zinc-600 font-mono shrink-0 ml-2">{durationMs}ms</span>
      )}
    </div>
  );
}

// ── Context bar ───────────────────────────────────────────────────────────────

function ContextBar({ used, size }: { used: number | null; size: number | null }) {
  if (!used || !size) return null;
  const pct = Math.min(100, Math.round((used / size) * 100));
  const color = pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px] text-zinc-500">
        <span>Context</span>
        <span className="font-mono">{pct}%</span>
      </div>
      <div className="w-full h-1 bg-white/[0.06] rounded-full overflow-hidden">
        <div
          className={`h-full ${color} transition-all duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Intervention sheet ────────────────────────────────────────────────────────

interface InterventionSheetProps {
  member: TeamMember;
  sessionId: string | null;
  isOpen: boolean;
  onClose: () => void;
}

function InterventionSheet({ member, sessionId, isOpen, onClose }: InterventionSheetProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const handleSend = useCallback(async () => {
    if (!message.trim() || !sessionId) return;
    setIsSending(true);
    try {
      await apiFetch<unknown>(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      setMessage('');
      toast.success('Message sent');
    } catch {
      toast.error('Failed to send message');
    } finally {
      setIsSending(false);
    }
  }, [message, sessionId]);

  const handleStop = useCallback(async () => {
    if (!sessionId) return;
    if (!confirmStop) {
      setConfirmStop(true);
      setTimeout(() => setConfirmStop(false), 3000);
      return;
    }
    try {
      await apiFetch<unknown>(`/api/sessions/${sessionId}/cancel`, {
        method: 'POST',
      });
      toast.success('Session stopped');
      onClose();
    } catch {
      toast.error('Failed to stop session');
    }
  }, [sessionId, confirmStop, onClose]);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="bg-[#0a0a0f] border-white/10 rounded-t-xl max-h-[60vh] flex flex-col"
      >
        <SheetHeader className="pb-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <AgentAvatar name={member.name} slug={member.agentType} size="md" />
            <SheetTitle className="text-sm font-semibold text-white">
              Intervene: {member.name}
            </SheetTitle>
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0 pt-3 space-y-3">
          {sessionId ? (
            <>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Send a message to this agent…"
                className="text-sm bg-white/[0.04] border-white/10 resize-none h-20 text-white placeholder:text-zinc-600"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 h-11 text-sm"
                  onClick={() => void handleSend()}
                  disabled={!message.trim() || isSending}
                >
                  {isSending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  <span className="ml-1.5">Send</span>
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-11 px-4 text-sm"
                  onClick={() => void handleStop()}
                >
                  <Square className="size-4" />
                  <span className="ml-1.5">{confirmStop ? 'Confirm?' : 'Stop'}</span>
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-zinc-500 text-center py-4">
              No active session for this agent.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface MobileAgentCardProps {
  member: TeamMember;
  liveState: AgentLiveState | null;
  sessionId: string | null;
}

export function MobileAgentCard({ member, liveState, sessionId }: MobileAgentCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const status = liveState?.status ?? null;
  const cfg = getStatusConfig(status);
  const currentActivity = liveState?.currentActivity ?? member.currentActivity ?? null;
  const model = liveState?.modelFromInit ?? member.model ?? null;
  const toolHistory = liveState?.recentToolHistory ?? [];

  return (
    <>
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div
          className={[
            'rounded-xl border bg-white/5 backdrop-blur transition-all duration-200',
            cfg.borderClass,
          ].join(' ')}
        >
          {/* Card header — always visible, tap to expand */}
          <CollapsibleTrigger asChild>
            <button
              className="w-full flex items-center gap-3 px-4 py-3.5 text-left min-h-[56px]"
              aria-expanded={isExpanded}
              aria-label={`${member.name} — ${cfg.label}. Tap to ${isExpanded ? 'collapse' : 'expand'}.`}
            >
              <AgentAvatar
                name={member.name}
                slug={member.agentType}
                size="lg"
                pulse={status === 'active'}
              />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-white truncate">{member.name}</span>
                  <Badge
                    variant="outline"
                    className={`text-[10px] px-1.5 py-0 h-4 font-mono border ${cfg.badgeClass}`}
                  >
                    {cfg.label}
                  </Badge>
                  {liveState?.hasApprovalPending && (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 h-4 bg-amber-500/10 text-amber-400 border-amber-500/30"
                    >
                      Approval needed
                    </Badge>
                  )}
                  {liveState?.hasRateLimit && (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 h-4 bg-orange-500/10 text-orange-400 border-orange-500/30"
                    >
                      Rate limited
                    </Badge>
                  )}
                </div>
                {model && (
                  <div className="text-[10px] text-zinc-500 font-mono mt-0.5 truncate">{model}</div>
                )}
                {currentActivity && (
                  <div className="text-[11px] text-zinc-400 font-mono mt-0.5 truncate">
                    {currentActivity}
                  </div>
                )}
              </div>

              {/* Chevron */}
              <span
                className={`text-zinc-500 transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                aria-hidden="true"
              >
                ▾
              </span>
            </button>
          </CollapsibleTrigger>

          {/* Expanded detail */}
          <CollapsibleContent>
            <div className="px-4 pb-4 space-y-3 border-t border-white/[0.06] pt-3">
              {/* Stats row */}
              <div className="flex gap-4 text-[11px] text-zinc-500 font-mono">
                {(liveState?.totalTurns ?? 0) > 0 && liveState && (
                  <span>{liveState.totalTurns} turns</span>
                )}
                {(liveState?.totalCostUsd ?? 0) > 0 && liveState && (
                  <span>${liveState.totalCostUsd.toFixed(3)}</span>
                )}
                {member.messageCount > 0 && <span>{member.messageCount} msgs</span>}
              </div>

              {/* Context bar */}
              <ContextBar
                used={liveState?.contextUsed ?? null}
                size={liveState?.contextSize ?? null}
              />

              {/* Recent tool history */}
              {toolHistory.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-mono">
                    Recent tools
                  </div>
                  <ScrollArea className="max-h-36">
                    <div className="space-y-1 pr-1">
                      {toolHistory
                        .slice()
                        .reverse()
                        .map((h, i) => (
                          <ToolHistoryRow key={i} toolName={h.toolName} durationMs={h.durationMs} />
                        ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {/* Intervene button */}
              <Button
                size="sm"
                variant="outline"
                className="w-full h-11 text-sm border-white/10 hover:bg-white/10 hover:text-white"
                onClick={(e) => {
                  e.stopPropagation();
                  setSheetOpen(true);
                }}
              >
                Intervene…
              </Button>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <InterventionSheet
        member={member}
        sessionId={sessionId}
        isOpen={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}
