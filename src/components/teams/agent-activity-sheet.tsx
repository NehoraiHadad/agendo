'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  X,
  Square,
  Send,
  Loader2,
  Terminal,
  Wrench,
  MessageSquare,
  AlertCircle,
  Info,
  CheckCircle,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { useSessionStream } from '@/hooks/use-session-stream';
import { apiFetch } from '@/lib/api-types';
import { toast } from 'sonner';
import type { TeamMember } from '@/hooks/use-team-state';
import type { AgentLiveState } from '@/stores/team-monitor-store';
import type { AgendoEvent } from '@/lib/realtime/events';

interface AgentActivitySheetProps {
  member: TeamMember | null;
  liveState: AgentLiveState | null;
  sessionId: string | null;
  isOpen: boolean;
  onClose: () => void;
}

interface EventRowConfig {
  icon: React.ReactNode;
  borderColor: string;
  bgColor: string;
  content: React.ReactNode;
  timestamp?: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getEventConfig(event: AgendoEvent): EventRowConfig | null {
  switch (event.type) {
    case 'agent:text':
      return {
        icon: <MessageSquare className="size-2.5 shrink-0" />,
        borderColor: 'rgba(99,102,241,0.5)',
        bgColor: 'rgba(99,102,241,0.03)',
        timestamp: event.ts,
        content: (
          <p className="text-[11px] text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">
            {event.text.slice(0, 400)}
            {event.text.length > 400 && (
              <span className="text-zinc-600"> …{event.text.length - 400} more chars</span>
            )}
          </p>
        ),
      };

    case 'user:message':
      return {
        icon: <Terminal className="size-2.5 shrink-0" />,
        borderColor: 'rgba(59,130,246,0.6)',
        bgColor: 'rgba(59,130,246,0.04)',
        timestamp: event.ts,
        content: (
          <p className="text-[11px] text-blue-300/90 leading-relaxed">
            {event.text.slice(0, 300)}
            {event.text.length > 300 && <span className="text-blue-500/60"> …</span>}
          </p>
        ),
      };

    case 'agent:tool-start':
      return {
        icon: <Wrench className="size-2.5 shrink-0" />,
        borderColor: 'rgba(245,158,11,0.5)',
        bgColor: 'rgba(245,158,11,0.03)',
        timestamp: event.ts,
        content: (
          <div className="flex items-center gap-2">
            <span
              className="size-1.5 rounded-full bg-amber-400 shrink-0"
              style={{ animation: 'toolPulse 0.9s ease-in-out infinite' }}
            />
            <span className="text-[10px] text-amber-300/80 font-mono">{event.toolName}</span>
          </div>
        ),
      };

    case 'agent:tool-end':
      return {
        icon: <CheckCircle className="size-2.5 shrink-0" />,
        borderColor: 'rgba(16,185,129,0.4)',
        bgColor: 'rgba(16,185,129,0.02)',
        timestamp: event.ts,
        content: (
          <span className="text-[10px] text-emerald-400/70 font-mono">
            done{event.durationMs ? ` · ${event.durationMs}ms` : ''}
          </span>
        ),
      };

    case 'agent:result':
      return {
        icon: <CheckCircle className="size-2.5 shrink-0" />,
        borderColor: 'rgba(99,102,241,0.4)',
        bgColor: 'rgba(99,102,241,0.02)',
        timestamp: event.ts,
        content: (
          <span className="text-[10px] text-zinc-500 font-mono">
            turn complete
            {event.costUsd ? ` · $${event.costUsd.toFixed(4)}` : ''}
            {event.durationMs ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ''}
          </span>
        ),
      };

    case 'session:state':
      return {
        icon: <Info className="size-2.5 shrink-0" />,
        borderColor: 'rgba(82,82,91,0.4)',
        bgColor: 'transparent',
        timestamp: event.ts,
        content: (
          <span className="text-[9px] text-zinc-600 font-mono tracking-widest uppercase">
            {event.status}
          </span>
        ),
      };

    case 'agent:tool-approval':
      return {
        icon: <AlertCircle className="size-2.5 shrink-0" />,
        borderColor: 'rgba(249,115,22,0.6)',
        bgColor: 'rgba(249,115,22,0.04)',
        timestamp: event.ts,
        content: (
          <span className="text-[10px] text-orange-400 font-mono">
            ⚠ approval needed: {event.toolName}
          </span>
        ),
      };

    case 'system:error':
      return {
        icon: <AlertCircle className="size-2.5 shrink-0" />,
        borderColor: 'rgba(239,68,68,0.6)',
        bgColor: 'rgba(239,68,68,0.04)',
        timestamp: event.ts,
        content: (
          <span className="text-[10px] text-red-400 font-mono break-words">{event.message}</span>
        ),
      };

    case 'system:info':
      return {
        icon: <Info className="size-2.5 shrink-0" />,
        borderColor: 'rgba(82,82,91,0.3)',
        bgColor: 'transparent',
        timestamp: event.ts,
        content: <span className="text-[9px] text-zinc-600 font-mono italic">{event.message}</span>,
      };

    default:
      return null;
  }
}

const VISIBLE_EVENT_TYPES = new Set([
  'agent:text',
  'agent:tool-start',
  'agent:tool-end',
  'agent:result',
  'session:state',
  'agent:tool-approval',
  'user:message',
  'system:info',
  'system:error',
]);

function ActivityFeed({ sessionId }: { sessionId: string }) {
  const { events } = useSessionStream(sessionId);
  const bottomRef = useRef<HTMLDivElement>(null);

  const visibleEvents = events.filter((e) => VISIBLE_EVENT_TYPES.has(e.type)).slice(-60);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleEvents.length]);

  if (visibleEvents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-36 gap-3">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1 rounded-full bg-zinc-700"
              style={{
                animation: 'typingDot 1.4s ease-in-out infinite',
                animationDelay: `${i * 0.25}s`,
              }}
            />
          ))}
        </div>
        <span className="text-[10px] text-zinc-700 font-mono tracking-widest">
          WAITING FOR ACTIVITY
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {visibleEvents.map((event) => {
        const config = getEventConfig(event);
        if (!config) return null;
        return (
          <div
            key={event.id}
            className="flex gap-2 rounded px-2 py-1.5 group transition-colors"
            style={{
              background: config.bgColor,
              borderLeft: `2px solid ${config.borderColor}`,
            }}
          >
            <div className="shrink-0 mt-0.5" style={{ color: config.borderColor }}>
              {config.icon}
            </div>
            <div className="flex-1 min-w-0">{config.content}</div>
            {config.timestamp && (
              <span className="text-[8px] text-zinc-700 font-mono shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {formatTime(config.timestamp)}
              </span>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

export function AgentActivitySheet({
  member,
  liveState,
  sessionId,
  isOpen,
  onClose,
}: AgentActivitySheetProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isStoppingConfirm, setIsStoppingConfirm] = useState(false);

  const handleSendMessage = useCallback(async () => {
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

  const handleStopSession = useCallback(async () => {
    if (!sessionId) return;
    if (!isStoppingConfirm) {
      setIsStoppingConfirm(true);
      setTimeout(() => setIsStoppingConfirm(false), 3000);
      return;
    }
    try {
      await apiFetch<unknown>(`/api/sessions/${sessionId}/cancel`, { method: 'POST' });
      toast.success('Session stopped');
      onClose();
    } catch {
      toast.error('Failed to stop session');
    }
  }, [sessionId, isStoppingConfirm, onClose]);

  if (!member) return null;

  const contextPct =
    liveState?.contextUsed && liveState.contextSize
      ? Math.round((liveState.contextUsed / liveState.contextSize) * 100)
      : null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-[380px] sm:w-[420px] flex flex-col p-0"
        style={{
          background: 'rgba(8,8,16,0.98)',
          borderLeft: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        {/* ── Header ── */}
        <SheetHeader
          className="px-4 py-3 border-b shrink-0"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}
        >
          <div className="flex items-center gap-3">
            <AgentAvatar
              name={member.name}
              slug={member.agentType}
              size="md"
              pulse={liveState?.status === 'active'}
            />
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-sm font-semibold text-white truncate">
                {member.name}
              </SheetTitle>
              {liveState?.modelFromInit && (
                <p className="text-[9px] text-zinc-600 font-mono mt-0.5">
                  {liveState.modelFromInit}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0 text-zinc-600 hover:text-white hover:bg-white/[0.05]"
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          {/* Telemetry row */}
          {liveState && (
            <div className="flex gap-3 text-[9px] text-zinc-600 font-mono pt-1.5 flex-wrap">
              {liveState.totalTurns > 0 && <span>{liveState.totalTurns} turns</span>}
              {liveState.totalCostUsd > 0 && <span>${liveState.totalCostUsd.toFixed(3)}</span>}
              {contextPct !== null && (
                <span
                  style={{
                    color: contextPct > 80 ? '#EF4444' : contextPct > 60 ? '#F59E0B' : undefined,
                  }}
                >
                  {contextPct}% ctx
                </span>
              )}
              {liveState.status && (
                <span
                  className={
                    liveState.status === 'active'
                      ? 'text-emerald-500'
                      : liveState.status === 'awaiting_input'
                        ? 'text-amber-500'
                        : liveState.status === 'ended'
                          ? 'text-blue-500'
                          : 'text-zinc-600'
                  }
                >
                  {liveState.status.toUpperCase().replace(/_/g, ' ')}
                </span>
              )}
            </div>
          )}
        </SheetHeader>

        {/* ── Activity feed ── */}
        <div className="flex-1 overflow-y-auto px-3 py-3 min-h-0">
          {sessionId ? (
            <ActivityFeed sessionId={sessionId} />
          ) : (
            <div className="flex items-center justify-center h-32 text-zinc-700 text-[10px] font-mono tracking-widest">
              NO SESSION CONNECTED
            </div>
          )}
        </div>

        {/* ── Intervention controls ── */}
        {sessionId && (
          <div
            className="shrink-0 border-t px-4 py-3 space-y-2"
            style={{ borderColor: 'rgba(255,255,255,0.06)' }}
          >
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSendMessage();
                }
              }}
              placeholder="Intervene — ⌘↵ to send…"
              className="text-[11px] font-mono resize-none h-16 text-white placeholder:text-zinc-700"
              style={{
                background: 'rgba(255,255,255,0.03)',
                borderColor: 'rgba(255,255,255,0.08)',
              }}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1 h-7 text-[10px] font-mono gap-1.5"
                onClick={() => void handleSendMessage()}
                disabled={!message.trim() || isSending}
              >
                {isSending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Send className="size-3" />
                )}
                SEND
              </Button>
              <Button
                size="sm"
                variant="outline"
                className={[
                  'h-7 text-[10px] font-mono gap-1.5 transition-all duration-200',
                  isStoppingConfirm
                    ? 'border-red-500/70 bg-red-500/10 text-red-400'
                    : 'border-zinc-700 bg-transparent text-zinc-500 hover:border-red-500/40 hover:text-red-400',
                ].join(' ')}
                onClick={() => void handleStopSession()}
              >
                <Square className="size-2.5" />
                {isStoppingConfirm ? 'CONFIRM?' : 'STOP'}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
