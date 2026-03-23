'use client';

import { useEffect, useRef, useState, useMemo, useCallback, type ChangeEvent } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  useTimelineStore,
  type TimelineEvent,
  type TimelineEventType,
} from '@/stores/timeline-store';

// ============================================================================
// Constants
// ============================================================================

const EVENT_TYPE_LABEL: Record<TimelineEventType, string> = {
  tool_call: 'Tool',
  message: 'Message',
  task_complete: 'Done',
  error: 'Error',
  awaiting_input: 'Waiting',
  status_change: 'Status',
};

const EVENT_TYPE_BADGE_CLASS: Record<TimelineEventType, string> = {
  tool_call: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  message: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  task_complete: 'bg-green-500/15 text-green-300 border-green-500/30',
  error: 'bg-red-500/15 text-red-300 border-red-500/30',
  awaiting_input: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
  status_change: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

const ALL_TYPES = Object.keys(EVENT_TYPE_LABEL) as TimelineEventType[];

// ============================================================================
// Props
// ============================================================================

export interface TeamActivityLogProps {
  /** Maximum number of entries to show (default: 500) */
  maxEntries?: number;
  className?: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Chronological activity log for all inter-agent events.
 *
 * Features:
 * - Reads from the global `useTimelineStore`
 * - Filter by agent (per-agent checkbox) and event type (type badges)
 * - Auto-scroll to bottom with a "lock scroll" toggle
 * - Terminal-style dark theme with monospace timestamps
 */
export function TeamActivityLog({ maxEntries = 500, className = '' }: TeamActivityLogProps) {
  const { events, selectedEventId, setSelectedEvent } = useTimelineStore();

  // ── Filter state ──────────────────────────────────────────────────────
  /**
   * Set of agent IDs the user has *explicitly disabled*.
   * All newly-seen agents are enabled by default — only exclusions are stored,
   * avoiding the sync-setState-in-effect anti-pattern.
   */
  const [disabledAgents, setDisabledAgents] = useState<Set<string>>(new Set());
  const [enabledTypes, setEnabledTypes] = useState<Set<TimelineEventType>>(new Set(ALL_TYPES));
  const [scrollLocked, setScrollLocked] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // ── Derived agent list (stable order: first seen) ──────────────────────
  const agentOrder = useMemo(() => {
    const seen = new Set<string>();
    const order: { id: string; name: string; color: string }[] = [];
    for (const ev of events) {
      if (!seen.has(ev.agentId)) {
        seen.add(ev.agentId);
        order.push({ id: ev.agentId, name: ev.agentName, color: ev.agentColor });
      }
    }
    return order;
  }, [events]);

  // ── Filtered + sliced events ──────────────────────────────────────────
  const visible = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase();
    return events
      .filter((ev) => {
        if (disabledAgents.has(ev.agentId)) return false;
        if (!enabledTypes.has(ev.type)) return false;
        if (lowerQuery && !ev.summary.toLowerCase().includes(lowerQuery)) return false;
        return true;
      })
      .slice(-maxEntries);
  }, [events, disabledAgents, enabledTypes, maxEntries, searchQuery]);

  // ── Auto-scroll ───────────────────────────────────────────────────────
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollLocked) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [visible, scrollLocked]);

  // ── Handlers ──────────────────────────────────────────────────────────
  const toggleAgent = useCallback((agentId: string) => {
    setDisabledAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        // Was disabled — re-enable it
        next.delete(agentId);
      } else {
        // Was enabled — disable it
        next.add(agentId);
      }
      return next;
    });
  }, []);

  const toggleType = useCallback((type: TimelineEventType) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  const handleEntryClick = useCallback(
    (ev: TimelineEvent) => {
      setSelectedEvent(ev.id === selectedEventId ? null : ev.id);
    },
    [selectedEventId, setSelectedEvent],
  );

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div
      className={`flex h-full flex-col rounded-md border border-white/10 bg-[#0a0a0f] ${className}`}
      role="region"
      aria-label="Team activity log"
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">
          Activity Log
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-zinc-600">
            {visible.length} / {events.length}
          </span>
          {/* Scroll lock toggle */}
          <button
            onClick={() => setScrollLocked((v) => !v)}
            className={`flex h-5 w-5 items-center justify-center rounded text-[10px] transition-colors ${
              scrollLocked
                ? 'bg-blue-500/20 text-blue-300'
                : 'bg-white/5 text-zinc-500 hover:bg-white/10 hover:text-zinc-300'
            }`}
            aria-label={
              scrollLocked
                ? 'Scroll lock on — click to disable'
                : 'Scroll lock off — click to enable'
            }
            title={scrollLocked ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
          >
            ↓
          </button>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="border-b border-white/[0.06] px-3 py-2 space-y-2">
        {/* Search */}
        <input
          type="search"
          placeholder="Filter events…"
          value={searchQuery}
          onChange={handleSearchChange}
          className="w-full rounded bg-white/5 px-2 py-1 font-mono text-[10px] text-zinc-300 placeholder-zinc-600 outline-none ring-0 focus:ring-1 focus:ring-white/20"
          aria-label="Search activity log"
        />

        {/* Event type toggles */}
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by event type">
          {ALL_TYPES.map((type) => {
            const active = enabledTypes.has(type);
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide transition-opacity ${
                  EVENT_TYPE_BADGE_CLASS[type]
                } ${active ? 'opacity-100' : 'opacity-30'}`}
                aria-pressed={active}
                aria-label={`${active ? 'Hide' : 'Show'} ${EVENT_TYPE_LABEL[type]} events`}
              >
                {EVENT_TYPE_LABEL[type]}
              </button>
            );
          })}
        </div>

        {/* Agent checkboxes */}
        {agentOrder.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1" role="group" aria-label="Filter by agent">
            {agentOrder.map((agent) => (
              <div key={agent.id} className="flex items-center gap-1">
                <Checkbox
                  id={`agent-filter-${agent.id}`}
                  checked={!disabledAgents.has(agent.id)}
                  onCheckedChange={() => toggleAgent(agent.id)}
                  className="h-3 w-3 rounded-sm"
                  aria-label={`${disabledAgents.has(agent.id) ? 'Show' : 'Hide'} events for ${agent.name}`}
                />
                <Label
                  htmlFor={`agent-filter-${agent.id}`}
                  className="flex cursor-pointer items-center gap-1 text-[9px] text-zinc-400 hover:text-zinc-200"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: agent.color }}
                    aria-hidden="true"
                  />
                  {agent.name}
                </Label>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Log entries ── */}
      <ScrollArea className="flex-1 min-h-0">
        <div
          className="space-y-px p-1"
          role="log"
          aria-live="polite"
          aria-label="Activity entries"
          aria-atomic="false"
        >
          {visible.length === 0 && (
            <div className="flex items-center justify-center py-8 text-[11px] text-zinc-600">
              {events.length === 0 ? 'Waiting for events…' : 'No events match the current filters'}
            </div>
          )}

          {visible.map((ev) => (
            <ActivityEntry
              key={ev.id}
              event={ev}
              isSelected={ev.id === selectedEventId}
              onClick={handleEntryClick}
            />
          ))}
        </div>
        {/* Sentinel for auto-scroll */}
        <div ref={bottomRef} aria-hidden="true" />
      </ScrollArea>
    </div>
  );
}

// ============================================================================
// ActivityEntry sub-component
// ============================================================================

interface ActivityEntryProps {
  event: TimelineEvent;
  isSelected: boolean;
  onClick: (ev: TimelineEvent) => void;
}

function ActivityEntry({ event, isSelected, onClick }: ActivityEntryProps) {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div
      className={`group flex cursor-pointer items-start gap-2 rounded px-2 py-1 transition-colors ${
        isSelected ? 'bg-white/8 ring-1 ring-white/15' : 'hover:bg-white/[0.04]'
      }`}
      onClick={() => onClick(event)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(event);
        }
      }}
      aria-pressed={isSelected}
      aria-label={`${event.agentName}: ${event.summary}`}
    >
      {/* Timestamp */}
      <span
        className="mt-0.5 shrink-0 font-mono text-[9px] text-zinc-600"
        aria-label={`At ${time}`}
      >
        {time}
      </span>

      {/* Agent color indicator */}
      <span
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: event.agentColor }}
        aria-hidden="true"
      />

      {/* Main content */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Agent name */}
          <span className="font-mono text-[10px] font-medium" style={{ color: event.agentColor }}>
            {event.agentName}
          </span>
          {/* Event type badge */}
          <span
            className={`rounded-sm border px-1 py-px font-mono text-[8px] uppercase tracking-wide ${
              EVENT_TYPE_BADGE_CLASS[event.type]
            }`}
            aria-label={`Event type: ${EVENT_TYPE_LABEL[event.type]}`}
          >
            {EVENT_TYPE_LABEL[event.type]}
          </span>
        </div>
        {/* Summary */}
        <p className="mt-0.5 truncate text-[10px] leading-snug text-zinc-400 group-hover:text-zinc-300">
          {event.summary}
        </p>
      </div>
    </div>
  );
}
