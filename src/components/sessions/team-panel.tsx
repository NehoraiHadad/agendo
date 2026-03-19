'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Users, Check, Loader2, ChevronLeft, Send, ArrowUpRight } from 'lucide-react';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TeamMessageCard, type TeamMessageItem } from './team-message-card';
import { getTeamColor } from '@/lib/utils/team-colors';
import { formatRelativeTime } from '@/lib/utils/format-time';
import type { TeamState, TeamMember, TeamTask, ActiveSubagent } from '@/hooks/use-team-state';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';
import { getErrorMessage } from '@/lib/utils/error-utils';

interface TeamPanelProps {
  teamState: TeamState;
  sessionId: string;
  sessionStatus: SessionStatus | null;
  className?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function MemberStatusPill({ status }: { status: TeamMember['status'] }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 shrink-0">
        <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
        active
      </span>
    );
  }
  if (status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-zinc-500/10 border border-zinc-600/20 text-zinc-400 shrink-0">
        <span className="size-1.5 rounded-full bg-zinc-500" />
        idle
      </span>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outbound message row (lead → teammate)
// ---------------------------------------------------------------------------

function OutboundMessage({ event }: { event: AgendoEvent }) {
  if (event.type !== 'team:outbox-message') return null;

  const relativeTime = formatRelativeTime(event.sourceTimestamp);
  const typeLabels: Record<string, string> = {
    task_assignment: 'task assigned',
    shutdown_request: 'shutdown request',
    plan_approval_response: 'plan response',
  };

  if (event.isStructured && event.structuredPayload) {
    const label = typeLabels[event.structuredPayload.type as string] ?? null;
    if (label) {
      return (
        <div className="flex items-start gap-2 pl-6">
          <div className="flex-1 bg-zinc-800/40 rounded-lg px-3 py-2 space-y-1 border border-white/[0.04]">
            <div className="flex items-center gap-2">
              <ArrowUpRight className="size-3 text-muted-foreground/40 shrink-0" />
              <span className="text-xs font-mono text-muted-foreground/50">team-lead</span>
              <span className="text-xs text-muted-foreground/35">{label}</span>
              <span className="ml-auto text-[10px] text-muted-foreground/25">{relativeTime}</span>
            </div>
          </div>
        </div>
      );
    }
  }

  return (
    <div className="flex items-start gap-2 pl-6">
      <div className="flex-1 bg-zinc-800/40 rounded-lg px-3 py-2 border border-white/[0.04]">
        <div className="flex items-center gap-1.5 mb-1.5">
          <ArrowUpRight className="size-3 text-muted-foreground/40 shrink-0" />
          <span className="text-xs font-mono text-muted-foreground/50">team-lead</span>
          {event.summary && (
            <span className="text-xs text-muted-foreground/35 truncate flex-1">
              {event.summary}
            </span>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground/25 shrink-0">
            {relativeTime}
          </span>
        </div>
        <div className="text-xs text-foreground/55 whitespace-pre-wrap break-words">
          {event.text}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline agent thread view (replaces tabs when a member is selected)
// ---------------------------------------------------------------------------

interface AgentThreadProps {
  member: TeamMember;
  inboundEvents: AgendoEvent[];
  outboundEvents: AgendoEvent[];
  sessionId: string;
  sessionStatus: SessionStatus | null;
  onBack: () => void;
  className?: string;
}

function AgentThread({
  member,
  inboundEvents,
  outboundEvents,
  sessionId,
  sessionStatus,
  onBack,
  className = '',
}: AgentThreadProps) {
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const colors = getTeamColor(member.color);

  const thread = useMemo(() => {
    const entries = [
      ...inboundEvents.map((e) => ({ kind: 'inbound' as const, ts: e.ts, event: e })),
      ...outboundEvents.map((e) => ({ kind: 'outbound' as const, ts: e.ts, event: e })),
    ];
    entries.sort((a, b) => a.ts - b.ts);
    return entries;
  }, [inboundEvents, outboundEvents]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.length]);

  const canSend =
    sessionStatus === 'awaiting_input' || sessionStatus === 'active' || sessionStatus === 'idle';

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isSending || !canSend) return;
    setIsSending(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/team-message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: member.name, text: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setText('');
      toast.success(`Message sent to ${member.name}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsSending(false);
    }
  }, [text, isSending, canSend, sessionId, member.name]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      className={`flex flex-col w-80 shrink-0 border-l border-white/[0.06] bg-[oklch(0.085_0_0)] overflow-hidden ${className}`}
    >
      {/* Thread header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2.5 shrink-0 border-b border-white/[0.04]">
        <button
          type="button"
          onClick={onBack}
          className="p-0.5 rounded hover:bg-white/[0.05] transition-colors text-muted-foreground/40 hover:text-muted-foreground/70 shrink-0"
          aria-label="Back to team"
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <span className={`text-sm ${colors.dot} select-none shrink-0`}>●</span>
        <span className="font-mono text-xs text-foreground/80 truncate flex-1 min-w-0">
          {member.name}
        </span>
        <span className="text-[10px] text-muted-foreground/35 bg-white/[0.04] rounded px-1.5 py-0.5 border border-white/[0.06] shrink-0">
          {member.agentType.replace('general-purpose', 'general').slice(0, 12)}
        </span>
        <MemberStatusPill status={member.status} />
      </div>

      {/* Agent info strip: model + activity + tool badges */}
      <div className="px-3 py-1.5 shrink-0 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground/25 font-mono">
          {member.model.replace('claude-', '')}
        </span>
        {member.currentActivity && member.currentActivity !== 'idle' && (
          <span className="text-[10px] text-blue-400/50 font-mono">{member.currentActivity}</span>
        )}
        {member.recentTools.length > 0 && (
          <div className="flex items-center gap-0.5 ml-auto">
            {member.recentTools.map((tool) => (
              <span
                key={tool}
                className="text-[9px] font-mono px-1 py-px rounded bg-white/[0.04] border border-white/[0.06] text-muted-foreground/30"
              >
                {tool}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Tool activity timeline (if any permission requests were observed) */}
      {member.toolEvents.length > 0 && (
        <div className="px-3 pb-1.5 shrink-0 border-b border-white/[0.04]">
          <div className="text-[9px] text-muted-foreground/25 uppercase tracking-widest mb-1">
            Tool Activity
          </div>
          <div className="flex flex-col gap-0.5 max-h-20 overflow-y-auto">
            {member.toolEvents.slice(-5).map((te, idx) => (
              <div key={idx} className="flex items-center gap-1.5 text-[10px]">
                <span className="font-mono text-amber-400/50 shrink-0">{te.toolName}</span>
                {te.filePath && (
                  <span className="text-muted-foreground/25 truncate font-mono">
                    {te.filePath.split('/').pop()}
                  </span>
                )}
                <span className="ml-auto text-muted-foreground/20 shrink-0">
                  {formatRelativeTime(te.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Thread body */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="px-4 py-3 space-y-2">
          {thread.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground/25">No messages yet</div>
          ) : (
            thread.map((entry, idx) => {
              if (entry.kind === 'inbound' && entry.event.type === 'team:message') {
                const ev = entry.event;
                const item: TeamMessageItem = {
                  id: ev.id,
                  fromAgent: ev.fromAgent,
                  text: ev.text,
                  summary: ev.summary,
                  color: ev.color,
                  isStructured: ev.isStructured,
                  structuredPayload: ev.structuredPayload,
                  sourceTimestamp: ev.sourceTimestamp,
                };
                return <TeamMessageCard key={`in-${idx}`} item={item} />;
              }
              if (entry.kind === 'outbound') {
                return <OutboundMessage key={`out-${idx}`} event={entry.event} />;
              }
              return null;
            })
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Compose bar */}
      <div className="shrink-0 border-t border-white/[0.04] px-3 py-3 space-y-2">
        {!canSend && (
          <p className="text-[10px] text-muted-foreground/30 text-center">
            Session must be active to send messages
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={canSend ? `Message ${member.name}… (⌘↵)` : 'Session not active'}
            disabled={!canSend || isSending}
            rows={2}
            className="flex-1 resize-none text-xs bg-white/[0.03] border-white/[0.08] focus-visible:ring-1 focus-visible:ring-white/20 placeholder:text-muted-foreground/25 min-h-0"
          />
          <Button
            size="sm"
            onClick={() => void handleSend()}
            disabled={!text.trim() || !canSend || isSending}
            className="h-9 px-3 shrink-0 bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] text-foreground/70 hover:text-foreground/90 transition-all"
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Member row (Team tab)
// ---------------------------------------------------------------------------

function MemberRow({
  member,
  messageCount,
  onClick,
}: {
  member: TeamMember;
  messageCount: number;
  onClick: () => void;
}) {
  const colors = getTeamColor(member.color);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex flex-col gap-1 px-3 py-2.5 hover:bg-white/[0.03] active:bg-white/[0.05] transition-colors rounded-lg text-left"
    >
      {/* Top row: name + status */}
      <div className="flex items-center gap-2 w-full">
        <span className={`text-sm ${colors.dot} select-none shrink-0 leading-none`}>●</span>
        <span className="font-mono text-xs text-foreground/80 truncate flex-1 min-w-0">
          {member.name}
        </span>
        {member.planModeRequired && (
          <span className="text-[9px] text-violet-400/70 bg-violet-500/10 rounded px-1 py-0.5 border border-violet-500/15 shrink-0">
            plan
          </span>
        )}
        <MemberStatusPill status={member.status} />
        {messageCount > 0 && (
          <span className="text-[9px] font-mono text-muted-foreground/30 shrink-0">
            {messageCount}
          </span>
        )}
      </div>
      {/* Bottom row: activity + tool badges */}
      <div className="flex items-center gap-1.5 pl-5 min-w-0">
        {member.currentActivity && (
          <span className="text-[10px] text-muted-foreground/35 truncate">
            {member.currentActivity}
          </span>
        )}
        {member.recentTools.length > 0 && (
          <div className="flex items-center gap-0.5 ml-auto shrink-0">
            {member.recentTools.slice(0, 3).map((tool) => (
              <span
                key={tool}
                className="text-[9px] font-mono px-1 py-px rounded bg-white/[0.04] border border-white/[0.06] text-muted-foreground/30"
              >
                {tool.length > 8 ? tool.slice(0, 8) : tool}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tasks tab
// ---------------------------------------------------------------------------

const TASK_STATUS_LABELS: Record<string, string> = {
  in_progress: 'In Progress',
  pending: 'Pending',
  completed: 'Completed',
};

const TASK_STATUS_ORDER = ['in_progress', 'pending', 'completed'] as const;

function TaskList({
  tasks,
  memberColorMap,
}: {
  tasks: TeamTask[];
  memberColorMap: Record<string, string | undefined>;
}) {
  if (tasks.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground/25">No tasks yet</div>
    );
  }

  const grouped = tasks.reduce<Record<string, TeamTask[]>>((acc, task) => {
    if (!acc[task.status]) acc[task.status] = [];
    acc[task.status].push(task);
    return acc;
  }, {});

  return (
    <div className="space-y-0.5 px-2 pb-2">
      {TASK_STATUS_ORDER.map((status) => {
        const statusTasks = grouped[status] ?? [];
        if (statusTasks.length === 0) return null;

        return (
          <div key={status}>
            <div className="px-1 py-1.5 text-[9px] font-semibold text-muted-foreground/25 uppercase tracking-widest">
              {TASK_STATUS_LABELS[status]} · {statusTasks.length}
            </div>
            {statusTasks.map((task) => {
              const ownerColor = task.owner ? getTeamColor(memberColorMap[task.owner]) : null;
              const isBlocked = task.blockedBy.length > 0;

              return (
                <div
                  key={task.id}
                  className={`flex items-start gap-2 px-2 py-2 rounded-lg mb-px ${
                    status === 'in_progress'
                      ? 'bg-blue-500/[0.05] border border-blue-500/[0.08]'
                      : status === 'completed'
                        ? 'opacity-40'
                        : 'hover:bg-white/[0.02]'
                  }`}
                >
                  <div className="mt-1 shrink-0">
                    {status === 'completed' ? (
                      <Check className="size-2.5 text-emerald-400/60" />
                    ) : status === 'in_progress' ? (
                      <span className="block size-1.5 rounded-full bg-blue-400 animate-pulse" />
                    ) : (
                      <span className="block size-1.5 rounded-full bg-zinc-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground/70 leading-snug line-clamp-2">
                      {task.subject}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {task.owner && ownerColor && (
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground/40">
                          <span className={`text-[8px] ${ownerColor.dot}`}>●</span>
                          {task.owner}
                        </span>
                      )}
                      {isBlocked && (
                        <span className="text-[9px] text-amber-400/50 bg-amber-500/[0.06] px-1 rounded">
                          blocked
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-[9px] font-mono text-muted-foreground/20 shrink-0 mt-0.5">
                    #{task.id}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subagents tab
// ---------------------------------------------------------------------------

function SubagentList({ subagents }: { subagents: ActiveSubagent[] }) {
  if (subagents.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground/25">
        No subagents spawned
      </div>
    );
  }

  return (
    <div className="space-y-0.5 px-2 pb-2">
      {subagents.map((sa) => (
        <div key={sa.agentId} className="flex items-start gap-2.5 px-2 py-2 rounded-lg">
          {sa.status === 'running' ? (
            <Loader2 className="size-3 text-blue-400 animate-spin shrink-0 mt-0.5" />
          ) : sa.status === 'complete' ? (
            <Check className="size-3 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <span className="text-xs text-red-400 shrink-0 mt-0.5">✕</span>
          )}
          <div className="flex-1 min-w-0">
            <div className="font-mono text-xs text-foreground/60 truncate">
              {sa.subagentType ?? 'subagent'}
            </div>
            {sa.description && (
              <div className="text-[10px] text-muted-foreground/35 truncate">
                {sa.description.length > 60 ? `${sa.description.slice(0, 60)}…` : sa.description}
              </div>
            )}
          </div>
          <span
            className={`text-[9px] font-mono shrink-0 mt-0.5 ${
              sa.status === 'running'
                ? 'text-blue-400/60'
                : sa.status === 'complete'
                  ? 'text-emerald-400/60'
                  : 'text-red-400/60'
            }`}
          >
            {sa.status}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main TeamPanel
// ---------------------------------------------------------------------------

export function TeamPanel({ teamState, sessionId, sessionStatus, className = '' }: TeamPanelProps) {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  if (!teamState.isActive) return null;

  const selectedMember = selectedAgent
    ? (teamState.members.find((m) => m.name === selectedAgent) ?? null)
    : null;

  // ── Inline thread view (push-navigation, no nested Sheet) ──────────────
  if (selectedMember) {
    return (
      <AgentThread
        member={selectedMember}
        inboundEvents={teamState.messagesByAgent[selectedMember.name] ?? []}
        outboundEvents={teamState.outboxByAgent[selectedMember.name] ?? []}
        sessionId={sessionId}
        sessionStatus={sessionStatus}
        onBack={() => setSelectedAgent(null)}
        className={className || 'flex md:flex w-80 shrink-0'}
      />
    );
  }

  // ── Tab view ────────────────────────────────────────────────────────────
  const inProgressCount = teamState.tasks.filter((t) => t.status === 'in_progress').length;
  const hasSubagents = teamState.subagents.length > 0;

  const memberColorMap: Record<string, string | undefined> = Object.fromEntries(
    teamState.members.map((m) => [m.name, m.color]),
  );

  return (
    <div
      className={`flex flex-col w-80 shrink-0 border-l border-white/[0.06] bg-[oklch(0.085_0_0)] overflow-hidden ${className}`}
    >
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 shrink-0">
        <Users className="size-3 text-muted-foreground/30 shrink-0" />
        <span className="font-mono text-xs text-muted-foreground/55 flex-1 truncate">
          {teamState.teamName}
        </span>
        <span className="text-[10px] text-muted-foreground/25 font-mono shrink-0">
          {teamState.members.length} agents
        </span>
      </div>

      <div className="h-px bg-white/[0.04] mx-3 shrink-0" />

      {/* Tabs */}
      <Tabs defaultValue="team" className="flex-1 min-h-0 flex flex-col overflow-hidden mt-1">
        <TabsList className="flex mx-2 mb-1 shrink-0 h-7 gap-0 bg-white/[0.02] border border-white/[0.04] rounded-md p-0.5">
          <TabsTrigger
            value="team"
            className="flex-1 text-[11px] h-6 rounded data-[state=active]:bg-white/[0.06]"
          >
            Team
          </TabsTrigger>
          <TabsTrigger
            value="tasks"
            className="flex-1 text-[11px] h-6 rounded data-[state=active]:bg-white/[0.06] gap-1"
          >
            Tasks
            {inProgressCount > 0 && (
              <span className="rounded-full bg-blue-500/20 text-blue-400 text-[9px] min-w-[14px] text-center leading-[14px] px-0.5">
                {inProgressCount}
              </span>
            )}
          </TabsTrigger>
          {hasSubagents && (
            <TabsTrigger
              value="agents"
              className="flex-1 text-[11px] h-6 rounded data-[state=active]:bg-white/[0.06]"
            >
              Agents
            </TabsTrigger>
          )}
        </TabsList>

        {/* Team tab */}
        <TabsContent
          value="team"
          forceMount
          className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden overflow-hidden"
        >
          <div className="h-full overflow-y-auto overscroll-contain">
            <div className="py-1">
              {teamState.members.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground/25">
                  No members yet
                </div>
              ) : (
                teamState.members.map((member) => (
                  <MemberRow
                    key={member.agentId}
                    member={member}
                    messageCount={teamState.messagesByAgent[member.name]?.length ?? 0}
                    onClick={() => setSelectedAgent(member.name)}
                  />
                ))
              )}
            </div>
          </div>
        </TabsContent>

        {/* Tasks tab */}
        <TabsContent
          value="tasks"
          forceMount
          className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden overflow-hidden"
        >
          <div className="h-full overflow-y-auto overscroll-contain">
            <div className="pt-1">
              <TaskList tasks={teamState.tasks} memberColorMap={memberColorMap} />
            </div>
          </div>
        </TabsContent>

        {/* Subagents tab */}
        {hasSubagents && (
          <TabsContent
            value="agents"
            forceMount
            className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden overflow-hidden"
          >
            <div className="h-full overflow-y-auto overscroll-contain">
              <div className="pt-1">
                <SubagentList subagents={teamState.subagents} />
              </div>
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
