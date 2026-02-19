'use client';

import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import type { Session } from '@/lib/types';
import type { UseSessionStreamReturn } from '@/hooks/use-session-stream';
import type { AgendoEvent } from '@/lib/realtime/events';

interface SessionInfoPanelProps {
  session: Session;
  stream: UseSessionStreamReturn;
  agentName: string;
  agentSlug: string;
}

function formatTimestamp(date: Date | null | undefined): string {
  if (!date) return '—';
  return format(date, 'PPpp');
}

function permissionModeLabel(mode: string): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'All tools auto-allowed';
    case 'acceptEdits':
      return 'File edits auto-allowed, bash requires approval';
    case 'default':
      return 'All tools require approval';
    default:
      return mode;
  }
}

function getLatestInitEvent(
  events: AgendoEvent[],
): Extract<AgendoEvent, { type: 'session:init' }> | null {
  const initEvents = events.filter(
    (e): e is Extract<AgendoEvent, { type: 'session:init' }> => e.type === 'session:init',
  );
  return initEvents.at(-1) ?? null;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-2 font-medium">
      {children}
    </h3>
  );
}

export function SessionInfoPanel({
  session,
  stream,
  agentName,
  agentSlug,
}: SessionInfoPanelProps) {
  const initEvent = getLatestInitEvent(stream.events);
  const mcpServers = initEvent?.mcpServers ?? [];
  const slashCommands = initEvent?.slashCommands ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Session metadata */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <SectionHeading>Session</SectionHeading>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <div>
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">ID</p>
            <p className="mt-0.5 font-mono text-xs break-all">{session.id}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Agent</p>
            <p className="mt-0.5 text-sm">
              {agentName}{' '}
              <span className="text-muted-foreground/50 text-xs font-mono">({agentSlug})</span>
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Status</p>
            <Badge variant="outline" className="mt-1 text-[10px]">
              {session.status}
            </Badge>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
              Permission Mode
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {permissionModeLabel(session.permissionMode)}
            </p>
          </div>
          {session.totalCostUsd !== null && session.totalCostUsd !== undefined && (
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Cost</p>
              <p className="mt-0.5 text-sm font-mono">
                ${Number(session.totalCostUsd).toFixed(4)}
              </p>
            </div>
          )}
          {session.totalTurns > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Turns</p>
              <p className="mt-0.5 text-sm font-mono">{session.totalTurns}</p>
            </div>
          )}
          <div>
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Started</p>
            <p className="mt-0.5 text-xs font-mono" suppressHydrationWarning>
              {formatTimestamp(session.startedAt)}
            </p>
          </div>
          {session.endedAt && (
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Ended</p>
              <p className="mt-0.5 text-xs font-mono" suppressHydrationWarning>
                {formatTimestamp(session.endedAt)}
              </p>
            </div>
          )}
          {session.sessionRef && (
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                Session Ref
              </p>
              <p className="mt-0.5 font-mono text-xs break-all">{session.sessionRef}</p>
            </div>
          )}
        </div>
      </div>

      {/* MCP Servers */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <SectionHeading>MCP Servers</SectionHeading>
        {mcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground/50">No MCP servers configured.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {mcpServers.map((srv) => (
              <div
                key={srv.name}
                className="flex items-start justify-between gap-4 rounded-md border border-white/[0.05] bg-white/[0.02] px-3 py-2"
              >
                <div>
                  <p className="text-sm font-mono">{srv.name}</p>
                  {srv.tools && srv.tools.length > 0 && (
                    <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                      Tools: {srv.tools.join(', ')}
                    </p>
                  )}
                </div>
                {srv.status && (
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {srv.status}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Slash Commands */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <SectionHeading>Available Commands</SectionHeading>
        {slashCommands.length === 0 ? (
          <p className="text-xs text-muted-foreground/50">No slash commands available.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {[...new Set(slashCommands)].map((cmd) => (
              <span
                key={cmd}
                className="rounded border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {cmd}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Allowed Tools */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <SectionHeading>Allowed Tools</SectionHeading>
        {session.allowedTools.length === 0 ? (
          <p className="text-xs text-muted-foreground/50">
            {permissionModeLabel(session.permissionMode)}.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {session.allowedTools.map((tool) => (
              <span
                key={tool}
                className="rounded border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {tool}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
