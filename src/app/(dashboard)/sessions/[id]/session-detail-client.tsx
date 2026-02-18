'use client';

import Link from 'next/link';
import { ArrowLeft, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSessionStream } from '@/hooks/use-session-stream';
import { SessionChatView } from '@/components/sessions/session-chat-view';
import type { Session } from '@/lib/types';
import type { SessionStatus } from '@/lib/realtime/events';

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
  capLabel,
  taskTitle,
}: SessionDetailClientProps) {
  const stream = useSessionStream(session.id);
  const currentStatus = stream.sessionStatus ?? session.status;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Link href={`/tasks/${session.taskId}`}>
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
          </div>
          <p className="mt-0.5 text-xs sm:text-sm text-muted-foreground truncate">
            {agentName} · {capLabel} · {taskTitle}
          </p>
        </div>
      </div>

      {/* Chat */}
      <SessionChatView
        sessionId={session.id}
        stream={stream}
        currentStatus={currentStatus}
      />
    </div>
  );
}
