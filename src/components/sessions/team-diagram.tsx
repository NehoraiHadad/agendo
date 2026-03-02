'use client';

import { useRef, useState, useEffect } from 'react';
import { getTeamColor } from '@/lib/utils/team-colors';
import type { TeamState } from '@/hooks/use-team-state';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';

// ─── Node dimensions ──────────────────────────────────────────────────────────

const NODE_W = 160;
const NODE_H = 72;
const LEAD_W = 176;
const LEAD_H = 80;
const SUBAGENT_W = 140;
const SUBAGENT_H = 56;
const TEAMMATE_RADIUS = 200;
const SUBAGENT_ROW_Y = 195; // px offset below center

// ─── Color name → CSS value (for SVG strokes / box-shadows) ──────────────────

const COLOR_CSS: Record<string, string> = {
  blue: 'oklch(0.65 0.2 250)',
  green: 'oklch(0.65 0.2 145)',
  purple: 'oklch(0.65 0.2 300)',
  red: 'oklch(0.65 0.2 25)',
  yellow: 'oklch(0.75 0.18 90)',
  orange: 'oklch(0.70 0.2 50)',
  cyan: 'oklch(0.70 0.15 200)',
  pink: 'oklch(0.65 0.2 340)',
};
const DEFAULT_COLOR_CSS = 'oklch(0.45 0 0)';

function colorCss(name: string | undefined): string {
  return COLOR_CSS[name ?? ''] ?? DEFAULT_COLOR_CSS;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface NodePos {
  x: number;
  y: number;
}

interface MessagePulse {
  id: string;
  fromAgent: string;
  color?: string;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TeamDiagramProps {
  teamState: TeamState;
  events: AgendoEvent[];
  sessionStatus?: SessionStatus | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TeamDiagram({ teamState, events, sessionStatus }: TeamDiagramProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasW, setCanvasW] = useState(800);
  const [canvasH, setCanvasH] = useState(500);
  const [pulses, setPulses] = useState<MessagePulse[]>([]);
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
  const lastMsgCountRef = useRef(0);

  // ── Observe canvas size ──────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setCanvasW(entry.contentRect.width);
      setCanvasH(entry.contentRect.height);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Track new team:message events → emit travel dots ─────────────────────
  useEffect(() => {
    const msgs = events.filter(
      (e): e is Extract<AgendoEvent, { type: 'team:message' }> => e.type === 'team:message',
    );
    if (msgs.length <= lastMsgCountRef.current) return;
    const newMsgs = msgs.slice(lastMsgCountRef.current);
    lastMsgCountRef.current = msgs.length;

    for (const msg of newMsgs) {
      // Skip idle_notification — shows as node pulse, not a travel dot
      if (msg.isStructured && msg.structuredPayload?.type === 'idle_notification') continue;

      const pulse: MessagePulse = {
        id: `${msg.fromAgent}-${msg.ts}-${Math.random().toString(36).slice(2)}`,
        fromAgent: msg.fromAgent,
        color: msg.color,
      };
      setPulses((prev) => [...prev, pulse]);
      setTimeout(() => {
        setPulses((prev) => prev.filter((p) => p.id !== pulse.id));
      }, 1600);

      // Mark edge as active; clear after 8s
      const agentName = msg.fromAgent;
      setActiveEdges((prev) => new Set([...prev, agentName]));
      setTimeout(() => {
        setActiveEdges((prev) => {
          const next = new Set(prev);
          next.delete(agentName);
          return next;
        });
      }, 8000);
    }
  }, [events]);

  // ── Layout math ───────────────────────────────────────────────────────────
  const cx = canvasW / 2;
  const cy = canvasH / 2;
  const teammates = teamState.members;
  const activeSubagents = teamState.subagents.filter((s) => s.status !== 'failed');

  const nodePos: Record<string, NodePos> = {};
  nodePos['__lead__'] = { x: cx, y: cy };

  teammates.forEach((member, i) => {
    const angle = (i / Math.max(1, teammates.length)) * 2 * Math.PI - Math.PI / 2;
    nodePos[member.name] = {
      x: cx + TEAMMATE_RADIUS * Math.cos(angle),
      y: cy + TEAMMATE_RADIUS * Math.sin(angle),
    };
  });

  activeSubagents.forEach((sa, i) => {
    const totalW = activeSubagents.length * (SUBAGENT_W + 12) - 12;
    const startX = cx - totalW / 2 + SUBAGENT_W / 2;
    nodePos[`__sa__${sa.agentId}`] = {
      x: startX + i * (SUBAGENT_W + 12),
      y: cy + SUBAGENT_ROW_Y,
    };
  });

  return (
    <div
      ref={canvasRef}
      className="relative w-full h-full overflow-hidden select-none"
      style={{
        background: 'oklch(0.06 0 0)',
        backgroundImage: 'radial-gradient(circle, oklch(0.14 0 0) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      {/* ── SVG edge layer ─────────────────────────────────────────────── */}
      <svg
        className="absolute inset-0 pointer-events-none"
        width={canvasW}
        height={canvasH}
        style={{ overflow: 'visible' }}
      >
        <defs>
          {/* Arrow markers per teammate color */}
          {teammates.map((m) => {
            const c = colorCss(m.color);
            return (
              <marker
                key={m.name}
                id={`arr-${m.name}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto"
              >
                <path
                  d="M0,0 L10,5 L0,10 z"
                  fill={activeEdges.has(m.name) ? c : 'oklch(0.28 0 0)'}
                />
              </marker>
            );
          })}
          <marker
            id="arr-default"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="oklch(0.22 0 0)" />
          </marker>
        </defs>

        {/* Teammate edges */}
        {teammates.map((m) => {
          const from = nodePos[m.name];
          const to = nodePos['__lead__'];
          if (!from || !to) return null;
          const isActive = activeEdges.has(m.name);
          const c = colorCss(m.color);
          return (
            <line
              key={m.name}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={isActive ? c : 'oklch(0.20 0 0)'}
              strokeWidth={isActive ? 1.5 : 1}
              strokeDasharray="5 4"
              style={{
                transition: 'stroke 0.4s ease, stroke-width 0.4s ease',
                filter: isActive ? `drop-shadow(0 0 3px ${c})` : 'none',
              }}
              markerEnd={`url(#arr-${m.name})`}
            />
          );
        })}

        {/* Subagent edges */}
        {activeSubagents.map((sa) => {
          const from = nodePos[`__sa__${sa.agentId}`];
          const to = nodePos['__lead__'];
          if (!from || !to) return null;
          return (
            <line
              key={sa.agentId}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="oklch(0.18 0 0)"
              strokeWidth={1}
              strokeDasharray="3 5"
              markerEnd="url(#arr-default)"
            />
          );
        })}
      </svg>

      {/* ── Message travel dots (CSS offset-path) ────────────────────────── */}
      {pulses.map((pulse) => {
        const from = nodePos[pulse.fromAgent];
        const to = nodePos['__lead__'];
        if (!from || !to) return null;
        const c = colorCss(pulse.color);
        const path = `M ${from.x.toFixed(1)},${from.y.toFixed(1)} L ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
        return (
          <div
            key={pulse.id}
            className="absolute pointer-events-none"
            style={
              {
                top: 0,
                left: 0,
                width: 7,
                height: 7,
                borderRadius: '50%',
                backgroundColor: c,
                boxShadow: `0 0 5px 2px ${c}`,
                offsetPath: `path('${path}')`,
                animation: 'travelDot 1.5s ease-in forwards',
                transform: 'translate(-50%, -50%)',
              } as React.CSSProperties
            }
          />
        );
      })}

      {/* ── Lead node ──────────────────────────────────────────────────────── */}
      {(() => {
        const p = nodePos['__lead__'];
        if (!p) return null;
        return (
          <div
            className="absolute rounded-lg border border-white/[0.12]"
            style={{
              width: LEAD_W,
              height: LEAD_H,
              left: p.x - LEAD_W / 2,
              top: p.y - LEAD_H / 2,
              background: 'oklch(0.13 0 0)',
              borderLeft: '3px solid oklch(0.80 0 0)',
              zIndex: 10,
            }}
          >
            <div className="flex flex-col justify-center h-full px-3 gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[9px] bg-white/[0.07] border border-white/[0.10] rounded px-1.5 py-px text-zinc-400 shrink-0 font-mono">
                  lead
                </span>
                <span className="font-mono text-[11px] text-foreground/90 font-semibold truncate">
                  {teamState.teamName ?? 'orchestrator'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-white/40 shrink-0" />
                <span className="text-[9px] text-muted-foreground/40 font-mono">
                  {teammates.length} teammate{teammates.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Teammate nodes ─────────────────────────────────────────────────── */}
      {teammates.map((member) => {
        const p = nodePos[member.name];
        if (!p) return null;
        const colors = getTeamColor(member.color);
        const inProgressTask = teamState.tasks.find(
          (t) => t.owner === member.name && t.status === 'in_progress',
        );
        const isActive = member.status === 'active';
        const c = colorCss(member.color);

        return (
          <div
            key={member.name}
            className={`absolute rounded-lg border ${colors.border}`}
            style={{
              width: NODE_W,
              height: NODE_H,
              left: p.x - NODE_W / 2,
              top: p.y - NODE_H / 2,
              background: 'oklch(0.105 0 0)',
              borderWidth: '1px',
              borderLeftWidth: '2px',
              boxShadow: isActive ? `0 0 14px -2px ${c}44` : 'none',
              transition: 'box-shadow 0.4s ease',
              zIndex: 5,
            }}
          >
            <div className="flex flex-col justify-center h-full px-3 py-2 gap-1">
              {/* Name row */}
              <div className="flex items-center gap-1.5">
                <span
                  className={`size-1.5 rounded-full shrink-0 ${
                    isActive ? `${colors.pulse} animate-pulse` : 'bg-zinc-600'
                  }`}
                />
                <span className="font-mono text-[11px] text-foreground/85 font-medium truncate">
                  {member.name}
                </span>
              </div>
              {/* Agent type badge */}
              <span className="text-[9px] text-muted-foreground/30 bg-white/[0.03] border border-white/[0.05] rounded px-1.5 py-px self-start truncate max-w-full">
                {member.agentType.replace('general-purpose', 'general').slice(0, 16)}
              </span>
              {/* Current task */}
              {inProgressTask && (
                <div
                  className="text-[9px] text-muted-foreground/28 truncate leading-tight"
                  title={inProgressTask.subject}
                >
                  {inProgressTask.subject.length > 36
                    ? `${inProgressTask.subject.slice(0, 36)}…`
                    : inProgressTask.subject}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* ── Subagent nodes ─────────────────────────────────────────────────── */}
      {activeSubagents.map((sa) => {
        const p = nodePos[`__sa__${sa.agentId}`];
        if (!p) return null;
        return (
          <div
            key={sa.agentId}
            className="absolute rounded-lg"
            style={{
              width: SUBAGENT_W,
              height: SUBAGENT_H,
              left: p.x - SUBAGENT_W / 2,
              top: p.y - SUBAGENT_H / 2,
              background: 'oklch(0.09 0 0)',
              border: '1px dashed oklch(0.22 0 0)',
              opacity: sa.status === 'complete' ? 0.35 : 1,
              transition: 'opacity 0.6s ease',
              zIndex: 5,
            }}
          >
            <div className="flex flex-col justify-center h-full px-2.5 py-2 gap-1">
              <div className="flex items-center gap-1.5">
                {sa.status === 'running' ? (
                  <span className="size-1.5 rounded-full bg-blue-400/50 animate-pulse shrink-0" />
                ) : (
                  <span className="size-1.5 rounded-full bg-zinc-700 shrink-0" />
                )}
                <span className="font-mono text-[10px] text-muted-foreground/45 truncate">
                  {sa.subagentType ?? 'subagent'}
                </span>
              </div>
              {sa.description && (
                <div className="text-[9px] text-muted-foreground/22 truncate">
                  {sa.description.slice(0, 28)}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* ── LIVE / Ended badge ──────────────────────────────────────────────── */}
      {teamState.isActive && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 pointer-events-none z-20">
          {sessionStatus === 'ended' ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-zinc-400/60 bg-black/40 backdrop-blur-sm rounded px-1.5 py-0.5 border border-zinc-600/20">
              <span className="size-1 rounded-full bg-zinc-500" />
              session ended
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-400/80 bg-black/40 backdrop-blur-sm rounded px-1.5 py-0.5 border border-emerald-500/15">
              <span className="size-1 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          )}
        </div>
      )}

      {/* ── Legend ──────────────────────────────────────────────────────────── */}
      {teamState.isActive && (
        <div className="absolute bottom-3 left-3 flex items-center gap-3 pointer-events-none z-20 bg-black/25 backdrop-blur-sm rounded px-2.5 py-1.5 border border-white/[0.04]">
          <span className="text-[9px] text-muted-foreground/30 font-mono flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-white/30 inline-block" />
            lead
          </span>
          <span className="text-[9px] text-muted-foreground/30 font-mono flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-blue-400/50 inline-block" />
            teammate
          </span>
          <span className="text-[9px] text-muted-foreground/30 font-mono flex items-center gap-1">
            <span
              className="inline-block border border-dashed border-zinc-600"
              style={{ width: 10, height: 8 }}
            />
            subagent
          </span>
          <span className="text-[9px] text-muted-foreground/30 font-mono">◉ message pulse</span>
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {!teamState.isActive && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <div className="text-[11px] text-muted-foreground/20 font-mono">no team active</div>
          <div className="text-[9px] text-muted-foreground/12">waiting for team:config event</div>
        </div>
      )}
    </div>
  );
}
