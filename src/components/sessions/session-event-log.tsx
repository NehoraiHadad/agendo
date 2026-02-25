'use client';

import { useState, useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { AgendoEvent } from '@/lib/realtime/events';

interface SessionEventLogProps {
  events: AgendoEvent[];
}

interface EventDisplayConfig {
  color: string;
  label: string;
  summary: (event: AgendoEvent) => string;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

function getEventConfig(event: AgendoEvent): EventDisplayConfig {
  switch (event.type) {
    case 'agent:text':
      return {
        color: 'text-zinc-300',
        label: 'agent:text',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:text' }>;
          return `"${truncate(ev.text, 80)}"`;
        },
      };
    case 'agent:thinking':
      return {
        color: 'text-zinc-500',
        label: 'agent:thinking',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:thinking' }>;
          return `"${truncate(ev.text, 80)}"`;
        },
      };
    case 'agent:text-delta':
      return {
        color: 'text-zinc-600',
        label: 'agent:text-delta',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:text-delta' }>;
          return `"${truncate(ev.text, 80)}"`;
        },
      };
    case 'agent:thinking-delta':
      return {
        color: 'text-zinc-600',
        label: 'agent:thinking-delta',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:thinking-delta' }>;
          return `"${truncate(ev.text, 80)}"`;
        },
      };
    case 'agent:tool-start':
      return {
        color: 'text-blue-400',
        label: 'agent:tool-start',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:tool-start' }>;
          const inputStr = JSON.stringify(ev.input);
          return `${ev.toolName} ${truncate(inputStr, 60)}`;
        },
      };
    case 'agent:tool-end':
      return {
        color: 'text-blue-300',
        label: 'agent:tool-end',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:tool-end' }>;
          const contentStr =
            typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content);
          return `${ev.toolUseId.slice(0, 8)} — ${truncate(contentStr, 60)}`;
        },
      };
    case 'agent:tool-approval':
      return {
        color: 'text-amber-400',
        label: 'agent:tool-approval',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:tool-approval' }>;
          return `${ev.toolName} (danger: ${ev.dangerLevel})`;
        },
      };
    case 'agent:ask-user':
      return {
        color: 'text-violet-400',
        label: 'agent:ask-user',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:ask-user' }>;
          const count = ev.questions.length;
          const first = ev.questions[0]?.header ?? ev.questions[0]?.question ?? '';
          return count === 1 ? first : `${count} questions — ${first}`;
        },
      };
    case 'agent:result':
      return {
        color: 'text-emerald-400',
        label: 'agent:result',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:result' }>;
          const parts: string[] = [];
          if (ev.costUsd !== null) parts.push(`$${ev.costUsd.toFixed(4)}`);
          if (ev.turns !== null) parts.push(`${ev.turns} turns`);
          if (ev.durationMs !== null) parts.push(`${Math.round(ev.durationMs / 1000)}s`);
          return parts.join(' · ') || '—';
        },
      };
    case 'agent:activity':
      return {
        color: 'text-zinc-500',
        label: 'agent:activity',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'agent:activity' }>;
          return ev.thinking ? 'thinking…' : 'idle';
        },
      };
    case 'user:message':
      return {
        color: 'text-emerald-300',
        label: 'user:message',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'user:message' }>;
          return `"${truncate(ev.text, 80)}"`;
        },
      };
    case 'session:init':
      return {
        color: 'text-violet-400',
        label: 'session:init',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'session:init' }>;
          return `ref=${ev.sessionRef} commands=${ev.slashCommands?.length ?? 0} mcp=${ev.mcpServers?.length ?? 0}`;
        },
      };
    case 'session:state':
      return {
        color: 'text-violet-300',
        label: 'session:state',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'session:state' }>;
          return ev.status;
        },
      };
    case 'system:info':
      return {
        color: 'text-zinc-400',
        label: 'system:info',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'system:info' }>;
          return ev.message;
        },
      };
    case 'system:error':
      return {
        color: 'text-red-400',
        label: 'system:error',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'system:error' }>;
          return ev.message;
        },
      };
    case 'team:message':
      return {
        color: 'text-cyan-400',
        label: 'team:message',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'team:message' }>;
          return `${ev.fromAgent}: ${truncate(ev.summary ?? ev.text, 80)}`;
        },
      };
    case 'system:mcp-status':
      return {
        color: 'text-amber-400',
        label: 'system:mcp-status',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'system:mcp-status' }>;
          return ev.servers.map((s) => `${s.name}: ${s.status}`).join(', ');
        },
      };
    case 'system:rate-limit':
      return {
        color: 'text-cyan-400',
        label: 'system:rate-limit',
        summary: (e) => {
          const ev = e as Extract<AgendoEvent, { type: 'system:rate-limit' }>;
          const resetDate = new Date(ev.resetsAt * 1000);
          const resetStr = resetDate.toLocaleTimeString();
          return `${ev.status} (${ev.rateLimitType}) resets ${resetStr}`;
        },
      };
  }
}

export function SessionEventLog({ events }: SessionEventLogProps) {
  const [query, setQuery] = useState('');

  const dedupedEvents = useMemo(() => {
    const seen = new Set<number>();
    return events.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }, [events]);

  const filtered = useMemo(() => {
    if (!query.trim()) return dedupedEvents;
    const lower = query.toLowerCase();
    return dedupedEvents.filter((e) => {
      if (e.type.toLowerCase().includes(lower)) return true;
      const cfg = getEventConfig(e);
      const summary = cfg.summary(e);
      return summary.toLowerCase().includes(lower);
    });
  }, [dedupedEvents, query]);

  return (
    <div className="flex flex-col gap-2">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50 pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter events…"
          className="pl-8 h-8 text-xs font-mono bg-white/[0.02] border-white/[0.06]"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setQuery('')}
            className="absolute right-1 top-1/2 -translate-y-1/2 size-6"
          >
            <X className="size-3" />
          </Button>
        )}
      </div>

      {/* Count */}
      <p className="text-[10px] text-muted-foreground/40 px-1">
        {filtered.length} of {dedupedEvents.length} event{dedupedEvents.length !== 1 ? 's' : ''}
      </p>

      {/* Event list */}
      <div
        className="h-[50dvh] min-h-[320px] overflow-auto rounded-md border border-white/[0.07] bg-[oklch(0.07_0_0)] font-mono text-xs leading-6"
        role="log"
        aria-label="Session events"
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground/40">
            {dedupedEvents.length === 0 ? 'No events yet.' : 'No events match the filter.'}
          </div>
        ) : (
          filtered.map((event) => {
            const cfg = getEventConfig(event);
            const summary = cfg.summary(event);
            const seqStr = String(event.id).padStart(4, ' ');
            return (
              <div
                key={`${event.id}-${event.type}`}
                className="flex gap-3 px-3 py-px hover:bg-white/[0.04] items-baseline"
              >
                <span className="select-none text-muted-foreground/25 tabular-nums shrink-0 w-[4ch] text-right">
                  {seqStr}
                </span>
                <span className={`shrink-0 w-[22ch] ${cfg.color}`}>{cfg.label}</span>
                <span className="text-muted-foreground/70 truncate">{summary}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
