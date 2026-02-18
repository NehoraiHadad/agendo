'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { formatDistanceStrict, format } from 'date-fns';
import { ArrowLeft, Terminal as TerminalIcon } from 'lucide-react';
import { ExecutionStatusBadge } from '@/components/executions/execution-status-badge';
import { ExecutionCancelButton } from '@/components/executions/execution-cancel-button';
import { ExecutionLogViewer } from '@/components/executions/execution-log-viewer';
import { ExecutionChatView } from '@/components/executions/execution-chat-view';
import { SessionChatView } from '@/components/sessions/session-chat-view';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useState } from 'react';
import { useExecutionStream } from '@/hooks/use-execution-stream';
import { useSessionStream } from '@/hooks/use-session-stream';
import type { ExecutionWithDetails } from '@/lib/services/execution-service';
import type { ExecutionStatus } from '@/lib/types';

const WebTerminal = dynamic(
  () => import('@/components/terminal/web-terminal').then((m) => m.WebTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[300px] items-center justify-center rounded-xl border border-white/[0.06] bg-[oklch(0.07_0_0)]">
        <span className="text-sm text-muted-foreground/60">Loading terminal…</span>
      </div>
    ),
  },
);

interface ExecutionDetailClientProps {
  execution: ExecutionWithDetails;
}

const ACTIVE_STATUSES = new Set<ExecutionStatus>(['queued', 'running', 'cancelling']);

function formatDuration(startedAt: Date | null, endedAt: Date | null): string {
  if (!startedAt) return 'Not started';
  const end = endedAt ?? new Date();
  return formatDistanceStrict(startedAt, end);
}

function formatTimestamp(date: Date | null): string {
  if (!date) return '-';
  return format(date, 'PPpp');
}

export function ExecutionDetailClient({ execution }: ExecutionDetailClientProps) {
  const [activeExecutionId, setActiveExecutionId] = useState(execution.id);
  const [activeSessionRef, setActiveSessionRef] = useState<string | null>(execution.sessionRef ?? null);

  // Session-based executions: use session stream for the chat tab.
  // Legacy executions (no sessionId): use the execution log stream.
  const sessionStream = useSessionStream(execution.sessionId ?? null);
  const legacyStream = useExecutionStream(execution.sessionId ? null : activeExecutionId);

  // Derive current status: session status → execution status mapping
  const sessionStatusToExecStatus = (s: string | null): ExecutionStatus | null => {
    if (!s) return null;
    if (s === 'active') return 'running';
    if (s === 'awaiting_input') return 'running';
    if (s === 'idle') return 'succeeded';
    if (s === 'ended') return 'succeeded';
    return null;
  };
  const currentStatus: ExecutionStatus =
    (execution.sessionId
      ? (sessionStatusToExecStatus(sessionStream.sessionStatus) ?? execution.status)
      : (legacyStream.status ?? execution.status)) as ExecutionStatus;

  const isActive = ACTIVE_STATUSES.has(currentStatus);
  const showTerminal =
    execution.tmuxSessionName && (currentStatus === 'running' || currentStatus === 'cancelling');

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Link href="/executions">
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-base sm:text-xl font-semibold font-mono">
              {execution.id.slice(0, 8)}
            </h1>
            <ExecutionStatusBadge status={currentStatus} />
          </div>
          <p className="mt-0.5 text-xs sm:text-sm text-muted-foreground truncate">
            {execution.agent.name} · {execution.capability.label}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showTerminal && (
            <Link href={`/executions/${execution.id}/terminal`} className="hidden sm:block">
              <Button variant="outline" size="sm">
                <TerminalIcon className="mr-2 h-4 w-4" />
                Terminal
              </Button>
            </Link>
          )}
          {(currentStatus === 'running' || currentStatus === 'queued') && (
            <ExecutionCancelButton
              executionId={activeExecutionId}
              status={currentStatus}
              onCancelled={() => {
                // Status will update via SSE stream automatically
              }}
            />
          )}
        </div>
      </div>

      {/* Metadata Grid */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:grid-cols-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Duration</p>
          <p className="mt-0.5 text-sm font-mono font-medium">
            {formatDuration(execution.startedAt, execution.endedAt)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Exit Code</p>
          <p className="mt-0.5 text-sm font-mono font-medium">
            {execution.exitCode !== null ? execution.exitCode : '—'}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Mode</p>
          <Badge variant="outline" className="mt-1 text-[10px]">
            {execution.mode}
          </Badge>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Started</p>
          <p className="mt-0.5 text-xs font-mono text-foreground/80" suppressHydrationWarning>{formatTimestamp(execution.startedAt)}</p>
        </div>
        {execution.totalCostUsd != null && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Cost</p>
            <p className="mt-0.5 text-sm font-mono font-medium">${Number(execution.totalCostUsd).toFixed(4)}</p>
          </div>
        )}
        {execution.totalTurns != null && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Turns</p>
            <p className="mt-0.5 text-sm font-mono font-medium">{execution.totalTurns}</p>
          </div>
        )}
      </div>

      {/* Tabbed Content: Chat / Logs / Terminal */}
      <Tabs defaultValue="chat" className="flex flex-col">
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            {showTerminal && <TabsTrigger value="terminal" className="hidden sm:inline-flex">Terminal</TabsTrigger>}
          </TabsList>
          {showTerminal && (
            <Link href={`/executions/${execution.id}/terminal`}>
              <Button variant="ghost" size="sm">
                <TerminalIcon className="mr-2 h-3.5 w-3.5" />
                Full Terminal
              </Button>
            </Link>
          )}
        </div>
        <TabsContent value="chat" className="mt-2">
          {execution.sessionId ? (
            <SessionChatView
              sessionId={execution.sessionId}
              stream={sessionStream}
              currentStatus={sessionStream.sessionStatus ?? execution.status}
            />
          ) : (
            <ExecutionChatView
              executionId={activeExecutionId}
              stream={legacyStream}
              currentStatus={currentStatus}
              resumeContext={!isActive && activeSessionRef ? {
                taskId: execution.taskId,
                agentId: execution.agentId,
                capabilityId: execution.capabilityId,
                parentExecutionId: activeExecutionId,
                sessionRef: activeSessionRef,
              } : undefined}
              onResumed={(newId) => setActiveExecutionId(newId)}
              onSessionRef={(ref) => setActiveSessionRef(ref)}
            />
          )}
        </TabsContent>
        <TabsContent value="logs" className="mt-2">
          <ExecutionLogViewer
            executionId={execution.id}
            initialStatus={execution.status}
            externalStream={execution.sessionId ? undefined : legacyStream}
          />
        </TabsContent>
        {showTerminal && (
          <TabsContent value="terminal" className="mt-2">
            <div className="sm:hidden rounded-xl border border-white/[0.06] p-5 text-center">
              <p className="text-sm text-muted-foreground/70">Terminal unavailable on mobile.</p>
              <Link href={`/executions/${execution.id}/terminal`} className="text-sm text-primary mt-2 inline-block">
                Open full terminal →
              </Link>
            </div>
            <div className="hidden sm:block">
              <WebTerminal executionId={execution.id} className="h-[400px]" />
            </div>
          </TabsContent>
        )}
      </Tabs>

    </div>
  );
}
