'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { formatDistanceStrict, format } from 'date-fns';
import { ArrowLeft, ExternalLink, Terminal as TerminalIcon } from 'lucide-react';
import { ExecutionStatusBadge } from '@/components/executions/execution-status-badge';
import { ExecutionCancelButton } from '@/components/executions/execution-cancel-button';
import { ExecutionLogViewer } from '@/components/executions/execution-log-viewer';
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
      <div className="flex h-[300px] items-center justify-center rounded-xl border border-white/[0.06] bg-[oklch(0.07_0_0)]">
        <span className="text-sm text-muted-foreground/60">Loading terminal…</span>
      </div>
    ),
  },
);

interface ExecutionDetailClientProps {
  execution: ExecutionWithDetails;
}

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
  const executionStream = useExecutionStream(execution.id);

  const currentStatus: ExecutionStatus = (executionStream.status ??
    execution.status) as ExecutionStatus;

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
              executionId={execution.id}
              status={currentStatus}
              onCancelled={() => {
                // Status will update via SSE stream automatically
              }}
            />
          )}
        </div>
      </div>

      {/* Session link banner */}
      {execution.sessionId && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/[0.06] px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">This execution is part of a session.</span>
          <Link
            href={`/sessions/${execution.sessionId}`}
            className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors ml-auto"
          >
            View session
            <ExternalLink className="size-3" />
          </Link>
        </div>
      )}

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
          <p className="mt-0.5 text-xs font-mono text-foreground/80" suppressHydrationWarning>
            {formatTimestamp(execution.startedAt)}
          </p>
        </div>
        {execution.totalCostUsd != null && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Cost</p>
            <p className="mt-0.5 text-sm font-mono font-medium">
              ${Number(execution.totalCostUsd).toFixed(4)}
            </p>
          </div>
        )}
        {execution.totalTurns != null && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Turns</p>
            <p className="mt-0.5 text-sm font-mono font-medium">{execution.totalTurns}</p>
          </div>
        )}
      </div>

      {/* Tabbed Content: Logs / Terminal */}
      <Tabs defaultValue="logs" className="flex flex-col">
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            {showTerminal && (
              <TabsTrigger value="terminal" className="hidden sm:inline-flex">
                Terminal
              </TabsTrigger>
            )}
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
        <TabsContent value="logs" className="mt-2">
          <ExecutionLogViewer
            executionId={execution.id}
            initialStatus={execution.status}
            externalStream={executionStream}
          />
        </TabsContent>
        {showTerminal && (
          <TabsContent value="terminal" className="mt-2">
            <div className="sm:hidden rounded-xl border border-white/[0.06] p-5 text-center">
              <p className="text-sm text-muted-foreground/70">Terminal unavailable on mobile.</p>
              <Link
                href={`/executions/${execution.id}/terminal`}
                className="text-sm text-primary mt-2 inline-block"
              >
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
