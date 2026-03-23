'use client';

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  useTimelineStore,
  type TimelineEvent,
  type TimelineEventType,
} from '@/stores/timeline-store';

// ============================================================================
// Constants
// ============================================================================

/** Width (px) of the sticky agent-name column on the left */
const LABEL_COL_WIDTH = 96;
/** Height (px) of each agent swim lane */
const LANE_HEIGHT = 22;
/** Height (px) of the time-marker axis row at the bottom */
const TIME_AXIS_HEIGHT = 24;
/** Radius (px) of a "routine" event dot */
const DOT_R_SMALL = 3;
/** Radius (px) of a "significant" event dot */
const DOT_R_LARGE = 6;
/** Padding (px) added after the last event / NOW marker so the line is never flush-right */
const RIGHT_PAD = 60;

// ============================================================================
// Color maps
// ============================================================================

/** Fill color per event type (hex) */
const EVENT_COLOR: Record<TimelineEventType, string> = {
  tool_call: '#a855f7', // purple
  message: '#3b82f6', // blue
  task_complete: '#22c55e', // green
  error: '#ef4444', // red
  awaiting_input: '#eab308', // yellow
  status_change: '#6b7280', // gray
};

/** Glow color (semi-transparent) for significant events on hover / selected */
const EVENT_GLOW: Record<TimelineEventType, string> = {
  tool_call: 'rgba(168,85,247,0.45)',
  message: 'rgba(59,130,246,0.45)',
  task_complete: 'rgba(34,197,94,0.45)',
  error: 'rgba(239,68,68,0.55)',
  awaiting_input: 'rgba(234,179,8,0.55)',
  status_change: 'rgba(107,114,128,0.35)',
};

/** Event types whose dots render at the larger radius */
const SIGNIFICANT: ReadonlySet<TimelineEventType> = new Set([
  'error',
  'task_complete',
  'awaiting_input',
]);

// ============================================================================
// Helpers
// ============================================================================

/** Format elapsed milliseconds as a human-readable label */
function fmtElapsed(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins === 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m${secs.toString().padStart(2, '0')}s`;
}

/** Choose a tick interval (ms) based on total visible duration */
function tickInterval(durationMs: number): number {
  if (durationMs < 2 * 60_000) return 30_000; // < 2 min  → 30s ticks
  if (durationMs < 10 * 60_000) return 60_000; // < 10 min → 1m ticks
  if (durationMs < 30 * 60_000) return 5 * 60_000; // < 30 min → 5m ticks
  return 10 * 60_000; // ≥ 30 min → 10m ticks
}

// ============================================================================
// Tooltip state
// ============================================================================

interface TooltipState {
  event: TimelineEvent;
  x: number;
  y: number;
}

// ============================================================================
// Props
// ============================================================================

export interface GlobalTimelineProps {
  /**
   * Called when the user clicks a dot.
   * The parent canvas should highlight the corresponding node.
   */
  onSelectAgent?: (agentId: string) => void;
  className?: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Horizontal "mission control" timeline bar for Monitor Mode.
 *
 * Renders one swim lane per agent, with colour-coded dots for each timeline
 * event. A red "NOW" line tracks current time. Clicking a dot selects the
 * event in the store (parent can react to highlight a canvas node).
 *
 * Layout: [sticky 96px label col] [overflow-x-auto SVG timeline]
 * Height: LANE_HEIGHT × agentCount + TIME_AXIS_HEIGHT (≥ 120px total)
 */
export function GlobalTimeline({ onSelectAgent, className = '' }: GlobalTimelineProps) {
  const { events, startTime, selectedEventId, zoomLevel, setSelectedEvent, setZoom } =
    useTimelineStore();

  // Scroll container ref for programmatic scroll + resize observation
  const scrollRef = useRef<HTMLDivElement>(null);
  // Canvas width (px) — updated by ResizeObserver
  const [viewportWidth, setViewportWidth] = useState(600);
  // Current time (ms) — updated every second
  const [now, setNow] = useState(() => Date.now());
  // Hover tooltip
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // ── ResizeObserver ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setViewportWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Clock tick ──────────────────────────────────────────────────────────
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ── Auto-scroll to NOW ──────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-scroll when the user hasn't manually scrolled
    const elapsed = (now - startTime) / 1000;
    const nowX = elapsed * zoomLevel;
    const maxScroll = nowX + RIGHT_PAD - viewportWidth;
    if (maxScroll > el.scrollLeft) {
      el.scrollLeft = maxScroll;
    }
  }, [now, startTime, zoomLevel, viewportWidth]);

  // ── Derived geometry ────────────────────────────────────────────────────
  const agentIds = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const ev of events) {
      if (!seen.has(ev.agentId)) {
        seen.add(ev.agentId);
        order.push(ev.agentId);
      }
    }
    return order;
  }, [events]);

  const agentMeta = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const ev of events) {
      if (!map.has(ev.agentId)) {
        map.set(ev.agentId, { name: ev.agentName, color: ev.agentColor });
      }
    }
    return map;
  }, [events]);

  const laneCount = Math.max(agentIds.length, 1);
  const svgHeight = laneCount * LANE_HEIGHT + TIME_AXIS_HEIGHT;
  const containerHeight = Math.max(120, svgHeight + 8);

  const elapsedSec = (now - startTime) / 1000;
  const nowX = elapsedSec * zoomLevel;
  const svgWidth = Math.max(viewportWidth, nowX + RIGHT_PAD);

  const duration = now - startTime;
  const tickMs = tickInterval(duration);
  const tickCount = Math.floor(duration / tickMs) + 1;

  // ── Zoom with scroll wheel ──────────────────────────────────────────────
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // only zoom when Ctrl/Cmd held
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.5 : 0.5;
      setZoom(zoomLevel + delta);
    },
    [zoomLevel, setZoom],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // ── Event hit test ──────────────────────────────────────────────────────
  const handleSvgClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // Find closest dot within hit radius
      let best: TimelineEvent | null = null;
      let bestDist = 14; // px hit radius

      for (const ev of events) {
        const laneIdx = agentIds.indexOf(ev.agentId);
        if (laneIdx === -1) continue;
        const x = ((ev.timestamp - startTime) / 1000) * zoomLevel;
        const y = laneIdx * LANE_HEIGHT + LANE_HEIGHT / 2;
        const dist = Math.hypot(clickX - x, clickY - y);
        if (dist < bestDist) {
          best = ev;
          bestDist = dist;
        }
      }

      if (best) {
        setSelectedEvent(best.id);
        onSelectAgent?.(best.agentId);
      } else {
        setSelectedEvent(null);
        setTooltip(null);
      }
    },
    [events, agentIds, startTime, zoomLevel, setSelectedEvent, onSelectAgent],
  );

  const handleSvgMouseMove = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let best: TimelineEvent | null = null;
      let bestDist = 12;

      for (const ev of events) {
        const laneIdx = agentIds.indexOf(ev.agentId);
        if (laneIdx === -1) continue;
        const x = ((ev.timestamp - startTime) / 1000) * zoomLevel;
        const y = laneIdx * LANE_HEIGHT + LANE_HEIGHT / 2;
        const dist = Math.hypot(mx - x, my - y);
        if (dist < bestDist) {
          best = ev;
          bestDist = dist;
        }
      }

      if (best) {
        setTooltip({ event: best, x: e.clientX, y: e.clientY });
      } else {
        setTooltip(null);
      }
    },
    [events, agentIds, startTime, zoomLevel],
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      className={`relative flex overflow-hidden rounded-md border border-white/10 bg-[#0a0a0f] ${className}`}
      style={{ height: containerHeight }}
      aria-label="Agent activity timeline"
      role="region"
    >
      {/* ── Left column: sticky agent name labels ── */}
      <div
        className="flex shrink-0 flex-col border-r border-white/10"
        style={{ width: LABEL_COL_WIDTH }}
      >
        {/* Empty header cell above the time axis */}
        <div className="flex flex-1 flex-col">
          {agentIds.length === 0 ? (
            <div
              className="flex items-center justify-center text-[10px] text-zinc-600"
              style={{ height: laneCount * LANE_HEIGHT }}
            >
              No events
            </div>
          ) : (
            agentIds.map((agentId, i) => {
              const meta = agentMeta.get(agentId);
              return (
                <div
                  key={agentId}
                  className="flex items-center gap-1.5 overflow-hidden px-2"
                  style={{ height: LANE_HEIGHT }}
                  title={meta?.name}
                >
                  {/* Agent color dot */}
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: meta?.color ?? '#6b7280' }}
                    aria-hidden="true"
                  />
                  <span
                    className="truncate font-mono text-[9px] leading-none text-zinc-400"
                    aria-label={`Agent ${i + 1}: ${meta?.name ?? agentId}`}
                  >
                    {meta?.name ?? agentId.slice(0, 8)}
                  </span>
                </div>
              );
            })
          )}
        </div>
        {/* Spacer for time axis row */}
        <div style={{ height: TIME_AXIS_HEIGHT }} className="border-t border-white/[0.06]" />
      </div>

      {/* ── Right column: scrollable SVG timeline ── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden"
        style={{ scrollBehavior: 'smooth' }}
        aria-label="Timeline scroll area"
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          style={{ display: 'block', cursor: 'crosshair' }}
          onClick={handleSvgClick}
          onMouseMove={handleSvgMouseMove}
          onMouseLeave={() => setTooltip(null)}
          aria-hidden="true"
          role="img"
        >
          {/* ── Swim lane separators ── */}
          {agentIds.map((_, i) => (
            <line
              key={`lane-sep-${i}`}
              x1={0}
              y1={(i + 1) * LANE_HEIGHT}
              x2={svgWidth}
              y2={(i + 1) * LANE_HEIGHT}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth={1}
            />
          ))}

          {/* ── Time marker ticks ── */}
          {Array.from({ length: tickCount }, (_, i) => {
            const tickOffsetMs = i * tickMs;
            const x = (tickOffsetMs / 1000) * zoomLevel;
            return (
              <g key={`tick-${i}`}>
                <line
                  x1={x}
                  y1={0}
                  x2={x}
                  y2={laneCount * LANE_HEIGHT}
                  stroke="rgba(255,255,255,0.06)"
                  strokeWidth={1}
                  strokeDasharray="3,4"
                />
                <text
                  x={x + 3}
                  y={laneCount * LANE_HEIGHT + TIME_AXIS_HEIGHT - 6}
                  fill="#555566"
                  fontSize={9}
                  fontFamily="ui-monospace, monospace"
                  aria-hidden="true"
                >
                  {fmtElapsed(tickOffsetMs)}
                </text>
              </g>
            );
          })}

          {/* ── Event dots ── */}
          {events.map((ev) => {
            const laneIdx = agentIds.indexOf(ev.agentId);
            if (laneIdx === -1) return null;

            const x = ((ev.timestamp - startTime) / 1000) * zoomLevel;
            const y = laneIdx * LANE_HEIGHT + LANE_HEIGHT / 2;
            const r = SIGNIFICANT.has(ev.type) ? DOT_R_LARGE : DOT_R_SMALL;
            const color = EVENT_COLOR[ev.type];
            const isSelected = ev.id === selectedEventId;

            return (
              <g key={ev.id}>
                {/* Glow halo for selected or significant events */}
                {(isSelected || SIGNIFICANT.has(ev.type)) && (
                  <circle cx={x} cy={y} r={r + 4} fill={EVENT_GLOW[ev.type]} aria-hidden="true" />
                )}
                {/* Main dot */}
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  fill={color}
                  stroke={isSelected ? '#fff' : 'none'}
                  strokeWidth={isSelected ? 1.5 : 0}
                  style={{ cursor: 'pointer' }}
                  aria-label={ev.summary}
                />
              </g>
            );
          })}

          {/* ── NOW marker (red vertical line) ── */}
          <line
            x1={nowX}
            y1={0}
            x2={nowX}
            y2={svgHeight}
            stroke="#ef4444"
            strokeWidth={1.5}
            strokeOpacity={0.8}
          />
          {/* NOW label */}
          <text
            x={nowX + 3}
            y={12}
            fill="#ef4444"
            fontSize={8}
            fontFamily="ui-monospace, monospace"
            opacity={0.7}
            aria-hidden="true"
          >
            NOW
          </text>
        </svg>
      </div>

      {/* ── Zoom controls ── */}
      <div className="absolute right-2 top-2 flex flex-col gap-0.5">
        <button
          onClick={() => setZoom(zoomLevel * 1.5)}
          className="flex h-5 w-5 items-center justify-center rounded bg-white/10 text-[10px] text-zinc-400 hover:bg-white/20 hover:text-zinc-200"
          aria-label="Zoom in timeline"
          title="Zoom in (or Ctrl+scroll)"
        >
          +
        </button>
        <button
          onClick={() => setZoom(zoomLevel / 1.5)}
          className="flex h-5 w-5 items-center justify-center rounded bg-white/10 text-[10px] text-zinc-400 hover:bg-white/20 hover:text-zinc-200"
          aria-label="Zoom out timeline"
          title="Zoom out (or Ctrl+scroll)"
        >
          −
        </button>
      </div>

      {/* ── Event tooltip ── */}
      {tooltip && <EventTooltip tooltip={tooltip} />}
    </div>
  );
}

// ============================================================================
// Tooltip sub-component
// ============================================================================

interface EventTooltipProps {
  tooltip: TooltipState;
}

function EventTooltip({ tooltip }: EventTooltipProps) {
  const { event, x, y } = tooltip;
  const color = EVENT_COLOR[event.type];

  return (
    <div
      className="pointer-events-none fixed z-50 max-w-[220px] rounded border border-white/10 bg-[#12121c] px-2.5 py-2 shadow-xl"
      style={{
        left: x + 12,
        top: y - 10,
        transform: 'translateY(-50%)',
      }}
      role="tooltip"
      aria-live="polite"
    >
      {/* Event type badge */}
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
          {event.type.replace(/_/g, ' ')}
        </span>
      </div>
      {/* Agent name */}
      <div className="mb-0.5 text-[11px] font-medium text-zinc-200">{event.agentName}</div>
      {/* Summary */}
      <div className="text-[10px] leading-snug text-zinc-400">{event.summary}</div>
      {/* Timestamp */}
      <div className="mt-1 font-mono text-[9px] text-zinc-600">
        {new Date(event.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}
