'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ArrowLeft, Circle, Loader2, PowerOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useSessionStream } from '@/hooks/use-session-stream';
import { useSessionLogStream } from '@/hooks/use-session-log-stream';
import { SessionChatView } from '@/components/sessions/session-chat-view';
import { SessionEventLog } from '@/components/sessions/session-event-log';
import { SessionInfoPanel } from '@/components/sessions/session-info-panel';
import { ExecutionLogViewer } from '@/components/executions/execution-log-viewer';
import type { Session } from '@/lib/types';
import type { SessionStatus } from '@/lib/realtime/events';

const WebTerminal = dynamic(
  () => import('@/components/terminal/web-terminal').then((m) => m.WebTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[400px] items-center justify-center rounded-xl border border-white/[0.06] bg-[oklch(0.07_0_0)]">
        <span className="text-sm text-muted-foreground/60">Loading terminal…</span>
      </div>
    ),
  },
);

interface SessionDetailClientProps {
  session: Session;
  agentName: string;
  agentSlug: string;
  capLabel: string;
  taskTitle: string;
}

function SessionStatusIndicator({ status }: { status: SessionStatus | null }) {
  if (!status) return null;

  const configs: Record<SessionStatus, { color: string; label: string; animate?: boolean }> = {
    active: { color: 'text-blue-400', label: 'Active', animate: true },
    awaiting_input: { color: 'text-emerald-400', label: 'Your turn', animate: false },
    idle: { color: 'text-zinc-400', label: 'Paused', animate: false },
    ended: { color: 'text-red-400', label: 'Ended', animate: false },
  };

  const cfg = configs[status];
  return (
    <span className={`flex items-center gap-1.5 text-xs ${cfg.color}`}>
      <Circle className={`size-2 fill-current ${cfg.animate ? 'animate-pulse' : ''}`} />
      {cfg.label}
    </span>
  );
}

export function SessionDetailClient({
  session,
  agentName,
  agentSlug,
  capLabel,
  taskTitle,
}: SessionDetailClientProps) {
  const searchParams = useSearchParams();
  const defaultTab = searchParams.get('tab') ?? 'chat';
  const stream = useSessionStream(session.id);
  const currentStatus = stream.sessionStatus ?? session.status;
  const logStream = useSessionLogStream(session.id);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isEnding, setIsEnding] = useState(false);

  async function handleEndSession() {
    if (isEnding) return;
    setIsEnding(true);
    setShowEndConfirm(false);
    try {
      await fetch(`/api/sessions/${session.id}/cancel`, { method: 'POST' });
    } finally {
      setIsEnding(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Link href="/sessions">
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-base sm:text-xl font-semibold font-mono">
              {session.id.slice(0, 8)}
            </h1>
            <SessionStatusIndicator status={currentStatus} />
            {currentStatus !== 'ended' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowEndConfirm(true)}
                disabled={isEnding}
                className="h-6 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20 gap-1"
              >
                {isEnding ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <PowerOff className="size-3" />
                )}
                End Session
              </Button>
            )}
          </div>
          <p className="mt-0.5 text-xs sm:text-sm text-muted-foreground truncate">
            {agentName} · {capLabel} · {taskTitle}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue={defaultTab} className="flex flex-col">
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="info">Info</TabsTrigger>
        </TabsList>

        <TabsContent value="chat" forceMount className="mt-4 data-[state=inactive]:hidden">
          <SessionChatView sessionId={session.id} stream={stream} currentStatus={currentStatus} />
        </TabsContent>

        <TabsContent value="terminal" className="mt-4">
          <WebTerminal sessionId={session.id} className="h-[500px]" />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <ExecutionLogViewer executionId={session.id} externalStream={logStream} />
        </TabsContent>

        <TabsContent value="events" className="mt-4">
          <SessionEventLog events={stream.events} />
        </TabsContent>

        <TabsContent value="info" className="mt-4">
          <SessionInfoPanel
            session={session}
            stream={stream}
            agentName={agentName}
            agentSlug={agentSlug}
          />
        </TabsContent>
      </Tabs>

      {/* End session confirmation */}
      <Dialog open={showEndConfirm} onOpenChange={(v) => !v && setShowEndConfirm(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End session?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The agent process will be killed and the session will be marked as ended. This cannot be
            undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEndConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleEndSession()}>
              End Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
