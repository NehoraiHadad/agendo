'use client';

import { useState, useCallback } from 'react';
import { X, Square, Send, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { useSessionStream } from '@/hooks/use-session-stream';
import { SessionChatView } from '@/components/sessions/session-chat-view';
import { apiFetch } from '@/lib/api-types';
import { toast } from 'sonner';
import type { TeamMember } from '@/hooks/use-team-state';
import type { AgentLiveState } from '@/stores/team-monitor-store';

interface AgentActivitySheetProps {
  member: TeamMember | null;
  liveState: AgentLiveState | null;
  sessionId: string | null;
  isOpen: boolean;
  onClose: () => void;
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

  // Called unconditionally to satisfy rules of hooks; hook handles null internally.
  const stream = useSessionStream(sessionId);

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

        {/* ── Chat view ── */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {sessionId ? (
            <SessionChatView
              sessionId={sessionId}
              stream={stream}
              currentStatus={liveState?.status ?? null}
              agentSlug={member.agentType}
              compact
            />
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
