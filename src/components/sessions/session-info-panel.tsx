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
  projectName?: string;
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

function getResultStats(events: AgendoEvent[]) {
  const results = events.filter(
    (e): e is Extract<AgendoEvent, { type: 'agent:result' }> => e.type === 'agent:result',
  );

  let totalApiMs = 0;
  let totalDurationMs = 0;
  let totalWebSearches = 0;
  let totalDenials = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let contextWindow: number | null = null;
  const modelCosts: Record<string, number> = {};

  for (const r of results) {
    if (r.durationApiMs) totalApiMs += r.durationApiMs;
    if (r.durationMs) totalDurationMs += r.durationMs;
    if (r.serverToolUse?.webSearchRequests) totalWebSearches += r.serverToolUse.webSearchRequests;
    if (r.permissionDenials) totalDenials += r.permissionDenials.length;
    if (r.modelUsage) {
      for (const [model, usage] of Object.entries(r.modelUsage)) {
        modelCosts[model] = (modelCosts[model] ?? 0) + usage.costUSD;
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        if (usage.cacheReadInputTokens) totalCacheRead += usage.cacheReadInputTokens;
        if (usage.cacheCreationInputTokens) totalCacheCreation += usage.cacheCreationInputTokens;
        if (usage.contextWindow) contextWindow = usage.contextWindow;
      }
    }
  }

  return {
    totalApiMs,
    totalDurationMs,
    totalWebSearches,
    totalDenials,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    totalCacheCreation,
    contextWindow,
    modelCosts,
    count: results.length,
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getLatestRateLimitEvent(events: AgendoEvent[]) {
  const rlEvents = events.filter(
    (e): e is Extract<AgendoEvent, { type: 'system:rate-limit' }> => e.type === 'system:rate-limit',
  );
  return rlEvents.at(-1) ?? null;
}

export function SessionInfoPanel({
  session,
  stream,
  agentName,
  agentSlug,
  projectName,
}: SessionInfoPanelProps) {
  const initEvent = getLatestInitEvent(stream.events);
  const mcpServers = initEvent?.mcpServers ?? [];
  const model = initEvent?.model ?? session.model;
  const slashCommands = initEvent?.slashCommands ?? [];
  const stats = getResultStats(stream.events);
  const rateLimit = getLatestRateLimitEvent(stream.events);

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
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Kind</p>
            <Badge variant="outline" className="mt-1 text-[10px]">
              {session.kind === 'conversation' ? 'Conversation' : 'Execution'}
            </Badge>
          </div>
          {projectName && (
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                Project
              </p>
              <p className="mt-0.5 text-sm">{projectName}</p>
            </div>
          )}
          {model && (
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Model</p>
              <p className="mt-0.5 text-xs font-mono text-muted-foreground">{model}</p>
            </div>
          )}
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
              <p className="mt-0.5 text-sm font-mono">${Number(session.totalCostUsd).toFixed(4)}</p>
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

      {/* Protocol Details (from system/init) */}
      {initEvent &&
        (initEvent.cwd ||
          initEvent.apiKeySource ||
          initEvent.tools ||
          initEvent.permissionMode) && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <SectionHeading>Protocol Details</SectionHeading>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              {initEvent.cwd && (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                    Working Dir
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground break-all">
                    {initEvent.cwd}
                  </p>
                </div>
              )}
              {initEvent.apiKeySource && (
                <div>
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                    API Key
                  </p>
                  <Badge variant="outline" className="mt-1 text-[10px]">
                    {initEvent.apiKeySource}
                  </Badge>
                </div>
              )}
              {initEvent.tools && (
                <div>
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                    Available Tools
                  </p>
                  <p className="mt-0.5 text-sm font-mono">{initEvent.tools.length}</p>
                </div>
              )}
              {initEvent.permissionMode && (
                <div>
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                    Active Mode
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {permissionModeLabel(initEvent.permissionMode)}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

      {/* Usage Stats (aggregated from result events) */}
      {stats.count > 0 && (stats.totalInputTokens > 0 || stats.totalApiMs > 0) && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <SectionHeading>Usage Stats</SectionHeading>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            {stats.totalInputTokens > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  Input Tokens
                </p>
                <p className="mt-0.5 text-sm font-mono">{formatTokens(stats.totalInputTokens)}</p>
              </div>
            )}
            {stats.totalOutputTokens > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  Output Tokens
                </p>
                <p className="mt-0.5 text-sm font-mono">{formatTokens(stats.totalOutputTokens)}</p>
              </div>
            )}
            {stats.contextWindow != null && stats.totalInputTokens > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  Context Window
                </p>
                <p className="mt-0.5 text-sm font-mono">
                  {formatTokens(stats.totalInputTokens)}
                  <span className="text-muted-foreground/50">
                    {' '}
                    / {formatTokens(stats.contextWindow)}
                  </span>
                </p>
                <div className="mt-1 h-1 bg-white/[0.05] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (stats.totalInputTokens / stats.contextWindow) * 100)}%`,
                      background:
                        stats.totalInputTokens / stats.contextWindow > 0.8
                          ? 'oklch(0.65 0.22 25)'
                          : 'oklch(0.7 0.18 280)',
                    }}
                  />
                </div>
              </div>
            )}
            {stats.totalCacheRead > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  Cache Read
                </p>
                <p className="mt-0.5 text-sm font-mono">{formatTokens(stats.totalCacheRead)}</p>
              </div>
            )}
            {stats.totalCacheCreation > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  Cache Written
                </p>
                <p className="mt-0.5 text-sm font-mono">{formatTokens(stats.totalCacheCreation)}</p>
              </div>
            )}
            {stats.totalApiMs > 0 && stats.totalDurationMs > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  API Time
                </p>
                <p className="mt-0.5 text-sm font-mono">
                  {(stats.totalApiMs / 1000).toFixed(1)}s
                  <span className="text-muted-foreground/50 text-xs ml-1">
                    ({Math.round((stats.totalApiMs / stats.totalDurationMs) * 100)}%)
                  </span>
                </p>
              </div>
            )}
            {stats.totalWebSearches > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  Web Searches
                </p>
                <p className="mt-0.5 text-sm font-mono">{stats.totalWebSearches}</p>
              </div>
            )}
            {stats.totalDenials > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  Denials
                </p>
                <p className="mt-0.5 text-sm font-mono text-amber-400/80">{stats.totalDenials}</p>
              </div>
            )}
            {Object.keys(stats.modelCosts).length > 1 && (
              <div className="col-span-2 sm:col-span-3">
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">
                  Per-Model Costs
                </p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(stats.modelCosts).map(([m, cost]) => (
                    <span
                      key={m}
                      className="rounded border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-xs text-muted-foreground"
                    >
                      {m.replace('claude-', '').replace(/-\d{8}$/, '')}: ${cost.toFixed(4)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rate Limit (from CLI rate_limit_event) */}
      {rateLimit && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <SectionHeading>Rate Limit</SectionHeading>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                Status
              </p>
              <Badge
                variant="outline"
                className={`mt-1 text-[10px] ${rateLimit.status === 'allowed' ? 'text-emerald-400 border-emerald-400/30' : 'text-red-400 border-red-400/30'}`}
              >
                {rateLimit.status}
              </Badge>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Type</p>
              <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                {rateLimit.rateLimitType}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                Resets At
              </p>
              <p
                className="mt-0.5 text-xs font-mono text-muted-foreground"
                suppressHydrationWarning
              >
                {new Date(rateLimit.resetsAt * 1000).toLocaleString()}
              </p>
            </div>
            {rateLimit.overageStatus && (
              <div>
                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                  Overage
                </p>
                <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                  {rateLimit.isUsingOverage ? 'Active' : rateLimit.overageStatus}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

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
