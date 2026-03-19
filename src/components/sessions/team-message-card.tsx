'use client';

import { useState, memo } from 'react';
import { ChevronDown, ChevronRight, Terminal, ScrollText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getTeamColor } from '@/lib/utils/team-colors';
import { formatRelativeTime } from '@/lib/utils/format-time';

/** Minimal shape accepted by TeamMessageCard — compatible with both
 *  DisplayItem (kind:'team-message') and AgendoEvent (type:'team:message'). */
export interface TeamMessageItem {
  id: number;
  fromAgent: string;
  text: string;
  summary?: string;
  color?: string;
  isStructured: boolean;
  structuredPayload?: Record<string, unknown>;
  sourceTimestamp: string;
}

/** Minimal Markdown component map — keeps font size consistent with chat. */
const mdComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-1 last:mb-0">{children}</p>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-');
    return isBlock ? (
      <code className="block bg-white/[0.04] rounded px-2 py-1 text-[11px] font-mono overflow-x-auto whitespace-pre">
        {children}
      </code>
    ) : (
      <code className="bg-white/[0.06] rounded px-0.5 text-[11px] font-mono">{children}</code>
    );
  },
};

// ---------------------------------------------------------------------------
// Structured payload renderers
// ---------------------------------------------------------------------------

function IdleNotificationCard({
  item,
  colors,
  relativeTime,
}: {
  item: TeamMessageItem;
  colors: ReturnType<typeof getTeamColor>;
  relativeTime: string;
}) {
  const reason = item.structuredPayload?.idleReason as string | undefined;
  return (
    <div
      className={`border-l-2 ${colors.border} ${colors.bg} rounded-r-md pl-3 py-1.5 flex items-center gap-2`}
    >
      <span className={`text-[10px] ${colors.dot} select-none`}>●</span>
      <span className="text-xs font-mono text-muted-foreground/60">{item.fromAgent}</span>
      <span className="text-xs text-muted-foreground/40">
        idle{reason === 'interrupted' ? ' (interrupted)' : ''}
      </span>
      <span className="ml-auto text-[10px] text-muted-foreground/30 pr-2">{relativeTime}</span>
    </div>
  );
}

function TaskAssignmentCard({
  item,
  colors,
  relativeTime,
}: {
  item: TeamMessageItem;
  colors: ReturnType<typeof getTeamColor>;
  relativeTime: string;
}) {
  const taskId = item.structuredPayload?.taskId as string | undefined;
  const subject = item.structuredPayload?.subject as string | undefined;
  return (
    <div className={`border-l-2 ${colors.border} ${colors.bg} rounded-r-md pl-3 py-2 space-y-1`}>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] ${colors.dot} select-none`}>●</span>
        <span className="text-xs font-mono text-muted-foreground/60">{item.fromAgent}</span>
        <span className="text-xs text-muted-foreground/40">task assigned</span>
        <span className="ml-auto text-[10px] text-muted-foreground/30 pr-2">{relativeTime}</span>
      </div>
      {(taskId ?? subject) && (
        <div className="text-xs text-muted-foreground/60">
          {taskId && <span className="font-mono text-muted-foreground/40">#{taskId}</span>}
          {subject && <span className="ml-1.5">{subject}</span>}
        </div>
      )}
    </div>
  );
}

function ShutdownRequestCard({
  item,
  colors,
  relativeTime,
}: {
  item: TeamMessageItem;
  colors: ReturnType<typeof getTeamColor>;
  relativeTime: string;
}) {
  const reason = item.structuredPayload?.reason as string | undefined;
  return (
    <div className={`border-l-2 ${colors.border} rounded-r-md pl-3 py-2 bg-zinc-800/30 space-y-1`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-zinc-400 select-none">⏹</span>
        <span className="text-xs font-mono text-muted-foreground/60">{item.fromAgent}</span>
        <span className="text-xs text-muted-foreground/50">requested shutdown</span>
        <span className="ml-auto text-[10px] text-muted-foreground/30 pr-2">{relativeTime}</span>
      </div>
      {reason && <div className="text-xs text-muted-foreground/40 pl-5">{reason}</div>}
    </div>
  );
}

function ShutdownApprovedCard({
  item,
  colors,
  relativeTime,
}: {
  item: TeamMessageItem;
  colors: ReturnType<typeof getTeamColor>;
  relativeTime: string;
}) {
  return (
    <div
      className={`border-l-2 ${colors.border} rounded-r-md pl-3 py-1.5 bg-emerald-900/10 flex items-center gap-2`}
    >
      <span className="text-[10px] text-emerald-400 select-none">✓</span>
      <span className="text-xs font-mono text-muted-foreground/60">{item.fromAgent}</span>
      <span className="text-xs text-emerald-400/60">approved shutdown</span>
      <span className="ml-auto text-[10px] text-muted-foreground/30 pr-2">{relativeTime}</span>
    </div>
  );
}

function PermissionRequestCard({
  item,
  colors,
  relativeTime,
}: {
  item: TeamMessageItem;
  colors: ReturnType<typeof getTeamColor>;
  relativeTime: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolName = item.structuredPayload?.tool_name as string | undefined;
  const description = item.structuredPayload?.description as string | undefined;
  const input = item.structuredPayload?.input as Record<string, unknown> | undefined;
  const command = input?.command as string | undefined;

  return (
    <div className={`border-l-2 ${colors.border} ${colors.bg} rounded-r-md pl-3 py-2 space-y-1.5`}>
      <div className="flex items-center gap-2">
        <Terminal className="size-3 text-amber-400/70 select-none shrink-0" />
        <span className="text-xs font-mono text-muted-foreground/60">{item.fromAgent}</span>
        <span className="text-xs text-amber-400/70">permission request</span>
        <span className="ml-auto text-[10px] text-muted-foreground/30 pr-2">{relativeTime}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {toolName && (
          <span className="text-[10px] font-mono bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-1.5 py-0.5">
            {toolName}
          </span>
        )}
        {description && (
          <span className="text-xs text-muted-foreground/50 truncate">{description}</span>
        )}
      </div>
      {(command ?? input) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`flex items-center gap-1 text-[10px] ${colors.dot} opacity-60 hover:opacity-100 transition-opacity`}
        >
          {expanded ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      )}
      {expanded && (
        <div className="text-[11px] font-mono bg-black/20 rounded p-2 text-muted-foreground/60 break-all whitespace-pre-wrap">
          {command ?? JSON.stringify(input, null, 2)}
        </div>
      )}
    </div>
  );
}

function PlanApprovalRequestCard({
  item,
  colors,
  relativeTime,
}: {
  item: TeamMessageItem;
  colors: ReturnType<typeof getTeamColor>;
  relativeTime: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Plan content may be in various fields depending on Claude's implementation
  const planContent =
    (item.structuredPayload?.plan as string | undefined) ??
    (item.structuredPayload?.content as string | undefined) ??
    item.text;

  return (
    <div className={`border-l-2 ${colors.border} ${colors.bg} rounded-r-md pl-3 py-2 space-y-1.5`}>
      <div className="flex items-center gap-2">
        <ScrollText className="size-3 text-violet-400/70 select-none shrink-0" />
        <span className="text-xs font-mono text-muted-foreground/60">{item.fromAgent}</span>
        <span className="text-xs text-violet-400/70">plan approval request</span>
        <span className="ml-auto text-[10px] text-muted-foreground/30 pr-2">{relativeTime}</span>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`flex items-center gap-1 text-[10px] ${colors.dot} opacity-60 hover:opacity-100 transition-opacity`}
      >
        {expanded ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
        {expanded ? 'Hide plan' : 'View plan'}
      </button>
      {expanded && planContent && (
        <div className="text-xs text-foreground/65 break-words overflow-hidden border-t border-white/[0.04] pt-1.5">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {planContent}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main TeamMessageCard
// ---------------------------------------------------------------------------

export const TeamMessageCard = memo(function TeamMessageCard({ item }: { item: TeamMessageItem }) {
  const [expanded, setExpanded] = useState(false);
  const colors = getTeamColor(item.color);
  const relativeTime = formatRelativeTime(item.sourceTimestamp);

  // Route to structured renderers
  if (item.isStructured && item.structuredPayload) {
    const msgType = item.structuredPayload.type as string | undefined;

    if (msgType === 'idle_notification') {
      return <IdleNotificationCard item={item} colors={colors} relativeTime={relativeTime} />;
    }
    if (msgType === 'task_assignment') {
      return <TaskAssignmentCard item={item} colors={colors} relativeTime={relativeTime} />;
    }
    if (msgType === 'shutdown_request') {
      return <ShutdownRequestCard item={item} colors={colors} relativeTime={relativeTime} />;
    }
    if (msgType === 'shutdown_approved') {
      return <ShutdownApprovedCard item={item} colors={colors} relativeTime={relativeTime} />;
    }
    if (msgType === 'permission_request') {
      return <PermissionRequestCard item={item} colors={colors} relativeTime={relativeTime} />;
    }
    if (msgType === 'plan_approval_request') {
      return <PlanApprovalRequestCard item={item} colors={colors} relativeTime={relativeTime} />;
    }
  }

  // Default: full markdown card with optional collapse after 6 lines
  const lines = item.text.split('\n');
  const COLLAPSE_THRESHOLD = 6;
  const shouldCollapse = lines.length > COLLAPSE_THRESHOLD;
  const displayText =
    shouldCollapse && !expanded ? lines.slice(0, COLLAPSE_THRESHOLD).join('\n') + '\n…' : item.text;

  return (
    <div
      className={`border-l-2 ${colors.border} ${colors.bg} rounded-r-md pl-3 pr-2 py-2 space-y-1.5`}
    >
      {/* Header row */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`text-[10px] ${colors.dot} select-none shrink-0`}>●</span>
        <span className="text-xs font-mono text-muted-foreground/70 shrink-0">
          {item.fromAgent}
        </span>
        {item.summary && (
          <span className="text-xs text-muted-foreground/45 truncate flex-1 min-w-0">
            {item.summary}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/30 shrink-0 ml-auto">
          {relativeTime}
        </span>
      </div>

      {/* Markdown content */}
      <div className="text-xs text-foreground/65 break-words overflow-hidden">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {displayText}
        </ReactMarkdown>
      </div>

      {/* Expand / collapse toggle */}
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`text-[10px] ${colors.dot} opacity-60 hover:opacity-100 transition-opacity`}
        >
          {expanded ? 'Show less ▲' : 'Show more ▼'}
        </button>
      )}
    </div>
  );
});
