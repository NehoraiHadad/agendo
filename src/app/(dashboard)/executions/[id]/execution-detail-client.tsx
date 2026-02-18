'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { formatDistanceStrict, format } from 'date-fns';
import { ArrowLeft, Terminal as TerminalIcon } from 'lucide-react';
import { ExecutionStatusBadge } from '@/components/executions/execution-status-badge';
import { ExecutionCancelButton } from '@/components/executions/execution-cancel-button';
import { ExecutionLogViewer } from '@/components/executions/execution-log-viewer';
import { ExecutionChatView } from '@/components/executions/execution-chat-view';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useExecutionStream } from '@/hooks/use-execution-stream';
import type { ExecutionWithDetails } from '@/lib/services/execution-service';
import type { ExecutionStatus } from '@/lib/types';

const WebTerminal = dynamic(
  () => import('@/components/terminal/web-terminal').then((m) => m.WebTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[300px] items-center justify-center rounded-lg border bg-zinc-950">
        <span className="text-sm text-muted-foreground">Loading terminal...</span>
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
  const stream = useExecutionStream(execution.id);
  const currentStatus = stream.status ?? execution.status;
  const isActive = ACTIVE_STATUSES.has(currentStatus);
  const showTerminal =
    execution.tmuxSessionName && (currentStatus === 'running' || currentStatus === 'cancelling');

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-3 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        <Link href="/executions">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">
              Execution <span className="font-mono">{execution.id.slice(0, 8)}</span>
            </h1>
            <ExecutionStatusBadge status={currentStatus} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {execution.agent.name} / {execution.capability.label}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {showTerminal && (
            <Link href={`/executions/${execution.id}/terminal`}>
              <Button variant="outline" size="sm">
                <TerminalIcon className="mr-2 h-4 w-4" />
                Full Terminal
              </Button>
            </Link>
          )}
          {(currentStatus === 'running' || currentStatus === 'queued') && (
            <ExecutionCancelButton
              executionId={execution.id}
              status={currentStatus}
              onCancelled={() => {
                // Status will update via SSE stream automatically
              }}
            />
          )}
        </div>
      </div>

      {/* Metadata Grid */}
      <div className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">Duration</p>
          <p className="mt-0.5 text-sm font-medium">
            {formatDuration(execution.startedAt, execution.endedAt)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Exit Code</p>
          <p className="mt-0.5 text-sm font-medium">
            {execution.exitCode !== null ? execution.exitCode : '-'}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Mode</p>
          <Badge variant="outline" className="mt-0.5">
            {execution.mode}
          </Badge>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Started</p>
          <p className="mt-0.5 text-sm font-medium">{formatTimestamp(execution.startedAt)}</p>
        </div>
        {execution.totalCostUsd != null && (
          <div>
            <p className="text-xs text-muted-foreground">Cost</p>
            <p className="mt-0.5 text-sm font-medium">${Number(execution.totalCostUsd).toFixed(4)}</p>
          </div>
        )}
        {execution.totalTurns != null && (
          <div>
            <p className="text-xs text-muted-foreground">Turns</p>
            <p className="mt-0.5 text-sm font-medium">{execution.totalTurns}</p>
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
          <ExecutionChatView
            executionId={execution.id}
            stream={stream}
            currentStatus={currentStatus}
          />
        </TabsContent>
        <TabsContent value="logs" className="mt-2">
          <ExecutionLogViewer
            executionId={execution.id}
            initialStatus={execution.status}
            externalStream={stream}
          />
        </TabsContent>
        {showTerminal && (
          <TabsContent value="terminal" className="mt-2">
            <div className="sm:hidden rounded-lg border p-4 text-center">
              <p className="text-sm text-muted-foreground">Terminal is not available on mobile.</p>
              <Link href={`/executions/${execution.id}/terminal`} className="text-sm text-primary underline mt-1 inline-block">
                Open full terminal
              </Link>
            </div>
            <div className="hidden sm:block">
              <WebTerminal executionId={execution.id} className="h-[400px]" />
            </div>
          </TabsContent>
        )}
      </Tabs>

      {/* Session Resume */}
      {execution.sessionRef && !isActive && (
        <div className="rounded-lg border border-dashed p-4 text-center">
          <p className="text-sm text-muted-foreground">
            Session <span className="font-mono">{execution.sessionRef}</span> available for resume.
          </p>
        </div>
      )}
    </div>
  );
}
