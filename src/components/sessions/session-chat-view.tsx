'use client';

import { useRef, useEffect, useState, useCallback, useMemo, memo } from 'react';
import {
  Bot,
  User,
  Wrench,
  ChevronDown,
  ChevronRight,
  Check,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  Square,
  ArrowDown,
  MessageSquare,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '@/components/ui/copy-button';
import { WriteView } from '@/components/executions/tool-views/write-view';
import { EditView } from '@/components/executions/tool-views/edit-view';
import { MultiEditView } from '@/components/executions/tool-views/multi-edit-view';
import { SessionMessageInput } from '@/components/sessions/session-message-input';
import { ToolApprovalCard } from '@/components/sessions/tool-approval-card';
import { InteractiveTool } from '@/components/sessions/interactive-tools';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';

// Module-level set keeps the early-return guard in ToolCard stable and avoids
// creating a dynamic component reference during render (react-hooks/static-components).
// Keep in sync with the TOOL_RENDERERS registry in interactive-tools.tsx.
const INTERACTIVE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);
import type { UseSessionStreamReturn } from '@/hooks/use-session-stream';
import {
  buildDisplayItems,
  buildToolResultMap,
  type ToolCallResult,
  type ToolState,
  type AssistantPart,
  type DisplayItem,
} from './session-chat-utils';

// ---------------------------------------------------------------------------
// Markdown renderer configuration
// ---------------------------------------------------------------------------

const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => (
    <p dir="auto" className="mb-1 last:mb-0 leading-relaxed">
      {children}
    </p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
  h1: ({ children }) => (
    <h1 dir="auto" className="text-base font-bold text-foreground mb-1 mt-2">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 dir="auto" className="text-sm font-bold text-foreground mb-1 mt-2">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 dir="auto" className="text-sm font-semibold text-foreground/90 mb-1 mt-1">
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul className="list-disc list-inside space-y-0.5 my-1 text-foreground/80">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside space-y-0.5 my-1 text-foreground/80">{children}</ol>
  ),
  li: ({ children }) => (
    <li dir="auto" className="leading-relaxed">
      {children}
    </li>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.startsWith('language-');
    const text = typeof children === 'string' ? children : String(children ?? '');
    return isBlock ? (
      <div className="relative my-1">
        <pre className="bg-black/50 rounded p-2 text-xs font-mono overflow-auto max-h-40 text-foreground/80 whitespace-pre pr-8">
          <code>{children}</code>
        </pre>
        <CopyButton text={text} className="absolute top-1 right-1" />
      </div>
    ) : (
      <code className="bg-white/[0.08] rounded px-1 text-xs font-mono text-foreground/90">
        {children}
      </code>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 my-1 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-white/[0.08] my-2" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-1 max-w-full">
      <table className="text-xs border-collapse w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-white/[0.10]">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-white/[0.05] last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold text-foreground/80 whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-2 py-1 text-foreground/70 break-words">{children}</td>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline hover:text-primary/80"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
};

// ---------------------------------------------------------------------------
// Tool result display
// ---------------------------------------------------------------------------

function ToolOutput({ name, result }: { name: string; result: ToolCallResult }) {
  const { content, isError } = result;
  if (!content) return null;

  const truncated = content.length > 800 ? content.slice(0, 800) + '\n…(truncated)' : content;
  const baseClass =
    'text-xs font-mono whitespace-pre-wrap break-all overflow-auto rounded p-2 mt-1 pr-8';

  let colorClass: string;
  if (isError) {
    colorClass = 'bg-red-950/50 text-red-300 max-h-32';
  } else {
    switch (name) {
      case 'Bash':
        colorClass = 'bg-black/40 text-emerald-300 max-h-48';
        break;
      case 'Read':
        colorClass = 'bg-black/40 text-blue-300 max-h-48';
        break;
      case 'Glob':
      case 'Grep':
        colorClass = 'bg-black/40 text-foreground/70 max-h-32';
        break;
      default:
        colorClass = 'bg-white/[0.03] text-muted-foreground max-h-24';
    }
  }

  return (
    <div className="relative mt-1">
      <pre className={`${baseClass} ${colorClass}`}>{truncated}</pre>
      <CopyButton text={content} className="absolute top-1 right-1" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolCard — collapsible card for tool calls (memoized to avoid re-renders)
// ---------------------------------------------------------------------------

const ToolCard = memo(function ToolCard({
  tool,
  sessionId,
}: {
  tool: ToolState;
  sessionId: string;
}) {
  // Derive open state: auto-open while pending or on error, auto-close on success.
  // manualOpen overrides auto-behavior once the user explicitly toggles.
  // Must be declared before any early return to satisfy Rules of Hooks.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  // Interactive tools (AskUserQuestion, ExitPlanMode, …) are handled by the
  // renderer registry. InteractiveTool is a stable component — not created
  // during render — so Fast Refresh and hook state are preserved correctly.
  if (INTERACTIVE_TOOL_NAMES.has(tool.toolName)) {
    return (
      <InteractiveTool
        toolName={tool.toolName}
        sessionId={sessionId}
        input={tool.input}
        isAnswered={tool.result !== undefined}
        respond={async (payload) => {
          if (payload.kind !== 'tool-result') return;
          const res = await fetch(`/api/sessions/${sessionId}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'tool-result',
              toolUseId: tool.toolUseId,
              content: payload.content,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `Server error ${res.status}`);
          }
        }}
      />
    );
  }

  const hasResult = tool.result !== undefined;
  const isError = tool.result?.isError ?? false;
  const open = manualOpen !== null ? manualOpen : !hasResult || isError;

  const statusIcon = !hasResult ? (
    <Loader2 className="size-3 text-zinc-400 animate-spin" />
  ) : isError ? (
    <span className="text-red-400 text-xs">✗</span>
  ) : (
    <Check className="size-3 text-emerald-400" />
  );

  const inputStr = Object.keys(tool.input).length > 0 ? JSON.stringify(tool.input, null, 2) : null;

  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden ${
        isError
          ? 'border-red-500/20 bg-red-500/[0.04]'
          : 'border-white/[0.06] bg-[oklch(0.075_0_0)]'
      }`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[0.03] transition-colors"
        onClick={() => setManualOpen((v) => (v !== null ? !v : !open))}
        aria-expanded={open}
      >
        <Wrench className="size-3 shrink-0 text-muted-foreground/35" />
        <span className="font-mono text-[11px] text-foreground/85 font-medium tracking-tight">
          {tool.toolName}
        </span>
        <span className="ml-1">{statusIcon}</span>
        <span className="ml-auto text-muted-foreground/30">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
      </button>

      {open && (
        <div className="px-2.5 pb-2 border-t border-white/[0.04]">
          {tool.toolName === 'Write' || tool.toolName === 'CreateFile' ? (
            <WriteView
              input={
                tool.input as {
                  content?: string;
                  new_file?: string;
                  path?: string;
                  file_path?: string;
                }
              }
            />
          ) : tool.toolName === 'Edit' || tool.toolName === 'str_replace_editor' ? (
            <EditView
              input={
                tool.input as {
                  old_string?: string;
                  new_string?: string;
                  path?: string;
                  file_path?: string;
                }
              }
            />
          ) : tool.toolName === 'MultiEdit' ? (
            <MultiEditView
              input={
                tool.input as {
                  edits?: Array<{
                    old_string?: string;
                    new_string?: string;
                    path?: string;
                  }>;
                  path?: string;
                }
              }
            />
          ) : (
            <>
              {inputStr && (
                <pre className="text-xs font-mono whitespace-pre-wrap break-all text-muted-foreground bg-black/40 rounded p-2 overflow-auto max-h-32">
                  {inputStr}
                </pre>
              )}
              {tool.result && <ToolOutput name={tool.toolName} result={tool.result} />}
            </>
          )}
          {/* Show tool result for Write/Edit/MultiEdit too */}
          {(tool.toolName === 'Write' ||
            tool.toolName === 'CreateFile' ||
            tool.toolName === 'Edit' ||
            tool.toolName === 'str_replace_editor' ||
            tool.toolName === 'MultiEdit') &&
            tool.result && (
              <div className="mt-1">
                <ToolOutput name={tool.toolName} result={tool.result} />
              </div>
            )}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// ToolGroup — collapses N consecutive tool calls into one expandable row
// ---------------------------------------------------------------------------

const ToolGroup = memo(function ToolGroup({
  tools,
  sessionId,
}: {
  tools: ToolState[];
  sessionId: string;
}) {
  const allDone = tools.every((t) => t.result !== undefined);
  const hasError = tools.some((t) => t.result?.isError);
  const hasPending = tools.some((t) => t.result === undefined);

  // Auto-open while any tool is in-flight or errored; auto-close when all succeed.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const autoOpen = !allDone || hasError;
  const open = manualOpen !== null ? manualOpen : autoOpen;

  // Collapsed summary: unique tool names with counts
  const nameCounts = tools.reduce<Record<string, number>>((acc, t) => {
    acc[t.toolName] = (acc[t.toolName] ?? 0) + 1;
    return acc;
  }, {});
  const summaryParts = Object.entries(nameCounts)
    .slice(0, 4)
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const summary = summaryParts.join(', ') + (Object.keys(nameCounts).length > 4 ? '…' : '');

  const statusIcon = hasPending ? (
    <Loader2 className="size-3 text-zinc-400 animate-spin shrink-0" />
  ) : hasError ? (
    <span className="text-red-400 text-xs shrink-0">✗</span>
  ) : (
    <Check className="size-3 text-emerald-400 shrink-0" />
  );

  return (
    <div className="rounded-lg border border-white/[0.06] bg-[oklch(0.075_0_0)] text-xs overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[0.03] transition-colors"
        onClick={() => setManualOpen((v) => (v !== null ? !v : !open))}
        aria-expanded={open}
      >
        <Wrench className="size-3 shrink-0 text-muted-foreground/35" />
        <span className="font-mono text-[11px] text-foreground/70 font-medium shrink-0">
          {tools.length} tools
        </span>
        {!open && (
          <span className="text-muted-foreground/35 truncate flex-1 min-w-0 text-[10px]">
            {summary}
          </span>
        )}
        <span className="shrink-0">{statusIcon}</span>
        <span className="ml-auto text-muted-foreground/30 shrink-0">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-white/[0.04] pt-1.5">
          {tools.map((tool) => (
            <ToolCard key={tool.toolUseId} tool={tool} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Bubble components
// ---------------------------------------------------------------------------

function InfoPill({ text }: { text: string }) {
  // Guard: raw JSON leaking into system:info (e.g. from a transient emit error)
  // must not flood the chat. Truncate JSON blobs to a safe preview length.
  const isRawJson = text.startsWith('{') || text.startsWith('[');
  const display = isRawJson ? text.slice(0, 120) + (text.length > 120 ? '…' : '') : text;
  return (
    <div className="flex justify-center my-2">
      <span className="text-[11px] text-muted-foreground/50 bg-white/[0.03] border border-white/[0.05] px-3 py-0.5 rounded-full max-w-full truncate tracking-wide">
        {display}
      </span>
    </div>
  );
}

function TurnCompletePill({
  text,
  costUsd,
  sessionCostUsd,
  isError,
}: {
  text: string;
  costUsd: number | null;
  sessionCostUsd: number | null;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasCost = costUsd !== null;
  const errorStyle = isError
    ? 'text-red-400 bg-red-500/[0.08] border-red-800/30'
    : 'text-muted-foreground/70 bg-white/[0.04] border-white/[0.05]';
  return (
    <div className="flex flex-col items-center my-1 gap-1">
      <button
        type="button"
        onClick={() => hasCost && setOpen((v) => !v)}
        className={`text-xs px-3 py-0.5 rounded-full border transition-colors ${errorStyle} ${
          hasCost
            ? 'hover:bg-white/[0.07] hover:border-white/[0.10] cursor-pointer'
            : 'cursor-default'
        }`}
      >
        {text}
        {hasCost && <span className="ml-1 opacity-40">{open ? '▲' : '▼'}</span>}
      </button>
      {open && hasCost && (
        <div className="bg-[oklch(0.12_0_0)] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-muted-foreground/80 shadow-lg space-y-1 min-w-[160px]">
          <div className="flex justify-between gap-4">
            <span>This turn</span>
            <span className="font-mono text-foreground/70">${(costUsd ?? 0).toFixed(4)}</span>
          </div>
          {sessionCostUsd !== null && (
            <div className="flex justify-between gap-4 border-t border-white/[0.06] pt-1">
              <span>Session total</span>
              <span className="font-mono text-foreground/70">${sessionCostUsd.toFixed(4)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorPill({ text }: { text: string }) {
  return (
    <div className="flex justify-center my-1">
      <span className="text-xs text-red-400 bg-red-500/[0.08] px-3 py-0.5 rounded-full border border-red-800/30">
        {text}
      </span>
    </div>
  );
}

/** Group consecutive tool parts (excluding AskUserQuestion) into ToolGroup cards. */
function renderAssistantParts(parts: AssistantPart[], sessionId: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let i = 0;

  while (i < parts.length) {
    const startIdx = i;
    const part = parts[i];

    if (part.kind === 'text') {
      result.push(
        <div
          key={`t-${startIdx}`}
          className="rounded-2xl rounded-tl-sm bg-white/[0.04] text-foreground border border-white/[0.06] px-3.5 py-2.5 text-sm break-words overflow-x-auto leading-relaxed"
          style={{ borderLeft: '2px solid oklch(0.7 0.18 280 / 0.18)' }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {part.text}
          </ReactMarkdown>
        </div>,
      );
      i++;
    } else {
      // Collect consecutive regular tool parts (break at AskUserQuestion)
      const toolGroup: ToolState[] = [];
      while (i < parts.length && parts[i].kind === 'tool') {
        const tp = parts[i] as { kind: 'tool'; tool: ToolState };
        if (tp.tool.toolName === 'AskUserQuestion') break;
        toolGroup.push(tp.tool);
        i++;
      }

      if (toolGroup.length === 0) {
        // AskUserQuestion — always standalone
        const tp = parts[i] as { kind: 'tool'; tool: ToolState };
        result.push(<ToolCard key={tp.tool.toolUseId} tool={tp.tool} sessionId={sessionId} />);
        i++;
      } else if (toolGroup.length < 2) {
        result.push(
          <ToolCard key={toolGroup[0].toolUseId} tool={toolGroup[0]} sessionId={sessionId} />,
        );
      } else {
        result.push(
          <ToolGroup
            key={`grp-${toolGroup[0].toolUseId}`}
            tools={toolGroup}
            sessionId={sessionId}
          />,
        );
      }
    }
  }

  return result;
}

function AssistantBubble({ parts, sessionId }: { parts: AssistantPart[]; sessionId: string }) {
  return (
    <div className="flex gap-2.5 items-start w-full animate-fade-in-up">
      {/* Agent avatar */}
      <div className="mt-0.5 flex-shrink-0 rounded-lg bg-primary/[0.10] border border-primary/20 p-1.5 shadow-[0_0_8px_oklch(0.7_0.18_280/0.12)]">
        <Bot className="size-3.5 text-primary/80" />
      </div>
      <div className="space-y-1.5 min-w-0 flex-1">{renderAssistantParts(parts, sessionId)}</div>
    </div>
  );
}

function ThinkingBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2.5 items-start w-full">
      <div className="mt-0.5 flex-shrink-0 rounded-lg bg-white/[0.04] border border-white/[0.06] p-1.5">
        <Bot className="size-3.5 text-muted-foreground/40" />
      </div>
      <div className="rounded-lg border border-white/[0.05] bg-white/[0.015] text-xs w-full overflow-hidden">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] rounded-lg transition-colors"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="text-muted-foreground/35 italic text-[11px] flex items-center gap-1.5">
            <span className="inline-block size-1 rounded-full bg-violet-400/40 animate-pulse" />
            Thinking…
          </span>
          <span className="ml-auto text-muted-foreground/25">
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </span>
        </button>
        {open && (
          <div className="px-3 pb-2.5 text-muted-foreground/50 whitespace-pre-wrap break-words text-xs font-mono border-t border-white/[0.04] pt-2">
            {text}
          </div>
        )}
      </div>
    </div>
  );
}

function UserBubble({
  text,
  hasImage,
  imageDataUrl,
}: {
  text: string;
  hasImage?: boolean;
  imageDataUrl?: string;
}) {
  return (
    <div className="flex gap-2.5 items-start justify-end animate-fade-in-up">
      <div
        dir="auto"
        className="rounded-2xl rounded-tr-sm ml-auto px-3.5 py-2.5 text-sm max-w-[85%] space-y-2 shadow-sm"
        style={{
          background:
            'linear-gradient(135deg, oklch(0.7 0.18 280 / 0.18) 0%, oklch(0.65 0.2 260 / 0.12) 100%)',
          border: '1px solid oklch(0.7 0.18 280 / 0.25)',
          boxShadow: '0 2px 12px oklch(0.7 0.18 280 / 0.08)',
        }}
      >
        {imageDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageDataUrl}
            alt="attachment"
            className="max-h-48 max-w-full rounded-lg object-contain"
          />
        ) : hasImage ? (
          <div className="flex items-center gap-1.5 text-xs text-primary/70">
            <Paperclip className="size-3 shrink-0" />
            <span>Image attached</span>
          </div>
        ) : null}
        {text && (
          <span className="whitespace-pre-wrap break-words block text-foreground/90">{text}</span>
        )}
      </div>
      {/* User avatar */}
      <div className="mt-0.5 flex-shrink-0 rounded-lg bg-primary/15 border border-primary/25 p-1.5">
        <User className="size-3.5 text-primary" />
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2.5 items-start animate-fade-in-up">
      <div className="mt-0.5 flex-shrink-0 rounded-lg bg-primary/[0.10] border border-primary/20 p-1.5 shadow-[0_0_8px_oklch(0.7_0.18_280/0.12)]">
        <Bot className="size-3.5 text-primary/80" />
      </div>
      <div className="rounded-2xl rounded-tl-sm bg-white/[0.04] border border-white/[0.06] px-4 py-3 flex gap-1.5 items-center">
        {/* Staggered bouncing dots */}
        <span
          className="inline-block size-1.5 rounded-full bg-primary/50"
          style={{ animation: 'typingDot 1.2s ease-in-out infinite', animationDelay: '0ms' }}
        />
        <span
          className="inline-block size-1.5 rounded-full bg-primary/50"
          style={{ animation: 'typingDot 1.2s ease-in-out infinite', animationDelay: '180ms' }}
        />
        <span
          className="inline-block size-1.5 rounded-full bg-primary/50"
          style={{ animation: 'typingDot 1.2s ease-in-out infinite', animationDelay: '360ms' }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TeamMessageCard — collapsible card for incoming team agent messages
// ---------------------------------------------------------------------------

/** Maps Claude team color names to Tailwind classes. */
const TEAM_COLORS: Record<string, { border: string; dot: string; bg: string }> = {
  blue: {
    border: 'border-l-blue-400',
    dot: 'text-blue-400',
    bg: 'bg-blue-400/[0.04]',
  },
  green: {
    border: 'border-l-emerald-400',
    dot: 'text-emerald-400',
    bg: 'bg-emerald-400/[0.04]',
  },
  purple: {
    border: 'border-l-purple-400',
    dot: 'text-purple-400',
    bg: 'bg-purple-400/[0.04]',
  },
  red: {
    border: 'border-l-red-400',
    dot: 'text-red-400',
    bg: 'bg-red-400/[0.04]',
  },
  yellow: {
    border: 'border-l-yellow-400',
    dot: 'text-yellow-400',
    bg: 'bg-yellow-400/[0.04]',
  },
  orange: {
    border: 'border-l-orange-400',
    dot: 'text-orange-400',
    bg: 'bg-orange-400/[0.04]',
  },
  cyan: {
    border: 'border-l-cyan-400',
    dot: 'text-cyan-400',
    bg: 'bg-cyan-400/[0.04]',
  },
};
const DEFAULT_TEAM_COLOR = {
  border: 'border-l-zinc-500',
  dot: 'text-zinc-400',
  bg: 'bg-zinc-400/[0.04]',
};

function formatRelativeTime(timestamp: string): string {
  try {
    const diffMs = Date.now() - new Date(timestamp).getTime();
    if (diffMs < 60_000) return 'just now';
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return `${Math.floor(diffMs / 86_400_000)}d ago`;
  } catch {
    return '';
  }
}

const TeamMessageCard = memo(function TeamMessageCard({
  item,
}: {
  item: Extract<DisplayItem, { kind: 'team-message' }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const colors = TEAM_COLORS[item.color ?? ''] ?? DEFAULT_TEAM_COLOR;
  const relativeTime = formatRelativeTime(item.sourceTimestamp);

  // idle_notification: render as a compact single-line badge — no content body
  if (item.isStructured && item.structuredPayload?.type === 'idle_notification') {
    return (
      <div
        className={`border-l-2 ${colors.border} ${colors.bg} rounded-r-md pl-3 py-1.5 flex items-center gap-2`}
      >
        <span className={`text-[10px] ${colors.dot} select-none`}>●</span>
        <span className="text-xs font-mono text-muted-foreground/60">{item.fromAgent}</span>
        <span className="text-xs text-muted-foreground/40">idle</span>
        <span className="ml-auto text-[10px] text-muted-foreground/30 pr-2">{relativeTime}</span>
      </div>
    );
  }

  // task_assignment: show compact card with task ID
  if (item.isStructured && item.structuredPayload?.type === 'task_assignment') {
    const taskId = item.structuredPayload.taskId as string | undefined;
    const taskTitle = item.structuredPayload.taskTitle as string | undefined;
    return (
      <div className={`border-l-2 ${colors.border} ${colors.bg} rounded-r-md pl-3 py-2 space-y-1`}>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] ${colors.dot} select-none`}>●</span>
          <span className="text-xs font-mono text-muted-foreground/60">{item.fromAgent}</span>
          <span className="text-xs text-muted-foreground/40">task assigned</span>
          <span className="ml-auto text-[10px] text-muted-foreground/30 pr-2">{relativeTime}</span>
        </div>
        {taskId && (
          <div className="text-xs text-muted-foreground/60">
            <span className="font-mono text-muted-foreground/40">{taskId.slice(0, 8)}</span>
            {taskTitle && <span className="ml-1.5">{taskTitle}</span>}
          </div>
        )}
      </div>
    );
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

// ---------------------------------------------------------------------------
// InitialPromptBanner — shows the prompt that kicked off the session
// ---------------------------------------------------------------------------

function InitialPromptBanner({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW_LEN = 220;
  const isLong = prompt.length > PREVIEW_LEN;
  const displayText = isLong && !expanded ? prompt.slice(0, PREVIEW_LEN) + '…' : prompt;

  return (
    <div
      className="rounded-xl overflow-hidden mb-1"
      style={{
        background:
          'linear-gradient(135deg, oklch(0.55 0.15 280 / 0.08) 0%, oklch(0.5 0.12 260 / 0.04) 100%)',
        border: '1px solid oklch(0.7 0.18 280 / 0.15)',
      }}
    >
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-violet-500/10">
        <MessageSquare className="size-3 text-violet-400/60 shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-violet-400/60">
          Initial prompt
        </span>
      </div>
      <div className="px-3 py-2.5 text-xs space-y-1.5">
        <p className="text-muted-foreground/55 whitespace-pre-wrap break-words leading-relaxed">
          {displayText}
        </p>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-violet-400/45 hover:text-violet-400/70 transition-colors text-[10px]"
          >
            {expanded ? 'Show less ▲' : 'Show more ▼'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SessionChatViewProps {
  sessionId: string;
  stream: UseSessionStreamReturn;
  currentStatus: SessionStatus | null | string;
  initialPrompt?: string | null;
  agentBinaryPath?: string;
  /** When true, renders a compact version for workspace panels (smaller text, less padding) */
  compact?: boolean;
  /** When true (compact mode only), panel grows with content instead of fixed height */
  autoGrow?: boolean;
}

export function SessionChatView({
  sessionId,
  stream,
  currentStatus,
  initialPrompt,
  agentBinaryPath,
  compact = false,
  autoGrow = false,
}: SessionChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<
    { id: string; text: string; imageDataUrl?: string }[]
  >([]);
  const [resolvedApprovals, setResolvedApprovals] = useState<Set<string>>(new Set());
  const [isInterrupting, setIsInterrupting] = useState(false);
  const msgIdRef = useRef(0);
  // Accumulates base64 image data URLs in send order so we can re-hydrate
  // user:message display items (which only carry hasImage:boolean, not the URL).
  const imageUrlsQueueRef = useRef<string[]>([]);

  const handleInterrupt = useCallback(async () => {
    if (isInterrupting) return;
    setIsInterrupting(true);
    try {
      await fetch(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
    } finally {
      setIsInterrupting(false);
    }
  }, [sessionId, isInterrupting]);

  const handleSent = useCallback((text: string, imageDataUrl?: string) => {
    if (imageDataUrl) imageUrlsQueueRef.current.push(imageDataUrl);
    setOptimisticMessages((prev) => [
      ...prev,
      { id: String(++msgIdRef.current), text, imageDataUrl },
    ]);
  }, []);

  const handleApprovalResolved = useCallback((approvalId: string) => {
    setResolvedApprovals((prev) => new Set(prev).add(approvalId));
  }, []);

  // Clear optimistic messages once the real user:message events arrive in stream
  useEffect(() => {
    const userMessageCount = stream.events.filter((e) => e.type === 'user:message').length;
    if (userMessageCount > 0 && optimisticMessages.length > 0) {
      setOptimisticMessages([]);
    }
  }, [stream.events, optimisticMessages.length]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distFromBottom < 80;
    isNearBottomRef.current = near;
    setUserScrolledUp(!near);
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setUserScrolledUp(false);
    isNearBottomRef.current = true;
  }, []);

  // Window scroll tracking for page-scroll mode (non-compact, non-fullscreen, or compact+autoGrow)
  useEffect(() => {
    if (fullscreen) return;
    if (compact && !autoGrow) return;
    const onWindowScroll = () => {
      const distFromBottom =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      const near = distFromBottom < 80;
      isNearBottomRef.current = near;
      setUserScrolledUp(!near);
    };
    window.addEventListener('scroll', onWindowScroll, { passive: true });
    return () => window.removeEventListener('scroll', onWindowScroll);
  }, [compact, autoGrow, fullscreen]);

  // Auto-scroll only when the user hasn't scrolled up
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [stream.events.length, optimisticMessages.length]);

  const toolResultMap = useMemo(() => buildToolResultMap(stream.events), [stream.events]);
  const displayItems = useMemo(
    () => buildDisplayItems(stream.events, toolResultMap),
    [stream.events, toolResultMap],
  );

  // Extract slash commands and MCP servers from the most recent session:init event
  const initEvent = stream.events
    .filter((e): e is Extract<typeof e, { type: 'session:init' }> => e.type === 'session:init')
    .at(-1);
  const slashCommands = initEvent?.slashCommands;
  const mcpServers = initEvent?.mcpServers;

  const isActive = currentStatus === 'active';

  // Drive typing indicator from session status OR from agent:activity thinking events.
  // findLast is available in Node 18+ / modern browsers; fall back to reverse iteration.
  const lastActivityEvent = [...stream.events]
    .reverse()
    .find((e) => e.type === 'agent:activity') as
    | (AgendoEvent & { type: 'agent:activity' })
    | undefined;
  const isThinking = lastActivityEvent?.thinking ?? false;
  const showTyping = (isActive || isThinking) && stream.isConnected;

  // Re-hydrate user items that have images: stream events only carry hasImage:boolean,
  // so we correlate them (in order) with the URLs we buffered at send time.
  const augmentedDisplayItems = (() => {
    let queueIdx = 0;
    return displayItems.map((item) => {
      if (item.kind === 'user' && item.hasImage) {
        return { ...item, imageDataUrl: imageUrlsQueueRef.current[queueIdx++] };
      }
      return item;
    });
  })();

  function renderDisplayItem(item: DisplayItem, idx: number): React.ReactNode {
    switch (item.kind) {
      case 'assistant':
        return <AssistantBubble key={idx} parts={item.parts} sessionId={sessionId} />;
      case 'thinking':
        return <ThinkingBubble key={idx} text={item.text} />;
      case 'user':
        return (
          <UserBubble
            key={idx}
            text={item.text}
            hasImage={item.hasImage}
            imageDataUrl={item.imageDataUrl}
          />
        );
      case 'turn-complete':
        return (
          <TurnCompletePill
            key={idx}
            text={item.text}
            costUsd={item.costUsd}
            sessionCostUsd={item.sessionCostUsd}
            isError={item.isError}
          />
        );
      case 'info':
        return <InfoPill key={idx} text={item.text} />;
      case 'error':
        return <ErrorPill key={idx} text={item.text} />;
      case 'tool-approval': {
        if (resolvedApprovals.has(item.approvalId)) return null;
        return (
          <ToolApprovalCard
            key={item.id}
            sessionId={sessionId}
            sessionStatus={currentStatus}
            approvalId={item.approvalId}
            toolName={item.toolName}
            toolInput={item.toolInput}
            dangerLevel={item.dangerLevel}
            onResolved={() => handleApprovalResolved(item.approvalId)}
          />
        );
      }
      case 'team-message':
        return <TeamMessageCard key={item.id} item={item} />;
    }
  }

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-[oklch(0.06_0_0)]'
          : compact && !autoGrow
            ? 'flex flex-col flex-1 min-h-0'
            : 'flex flex-col rounded-xl border border-white/[0.07]'
      }
    >
      {/* Header — hidden in compact mode (workspace panel has its own header) */}
      {!compact && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.07] shrink-0 bg-[oklch(0.09_0_0)] rounded-t-xl">
          <span className="text-xs text-muted-foreground/50">Session Chat</span>
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </div>
      )}

      {/* Chat area */}
      <div
        ref={(compact && !autoGrow) || fullscreen ? scrollContainerRef : undefined}
        onScroll={(compact && !autoGrow) || fullscreen ? handleScroll : undefined}
        className={
          fullscreen
            ? 'flex-1 overflow-y-auto overflow-x-hidden bg-[oklch(0.07_0_0)] p-3 sm:p-4 space-y-3'
            : compact && !autoGrow
              ? 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-[oklch(0.07_0_0)] p-2 space-y-2'
              : compact && autoGrow
                ? 'overflow-x-hidden bg-[oklch(0.07_0_0)] p-2 space-y-2'
                : 'overflow-x-hidden bg-[oklch(0.07_0_0)] p-3 sm:p-4 space-y-3'
        }
        role="log"
        aria-live="polite"
        aria-label="Session chat"
      >
        {stream.events.length === 0 && !stream.error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground/60">
            {currentStatus === 'idle' ? (
              <span className="text-xs">Send a message to start the conversation</span>
            ) : (
              <>
                <Loader2 className="size-5 animate-spin" />
                <span className="text-xs">
                  {stream.isConnected ? 'Waiting for agent…' : 'Connecting…'}
                </span>
              </>
            )}
          </div>
        )}

        {/* Initial prompt banner — shown once at the top if present */}
        {initialPrompt && <InitialPromptBanner prompt={initialPrompt} />}

        {augmentedDisplayItems.map((item, i) => renderDisplayItem(item, i))}

        {/* Optimistic user messages shown while real event is in-flight */}
        {optimisticMessages.map((msg) => (
          <UserBubble key={`opt-${msg.id}`} text={msg.text} imageDataUrl={msg.imageDataUrl} />
        ))}

        {showTyping && <TypingIndicator />}

        {stream.error && <ErrorPill text={`Stream error: ${stream.error}`} />}

        {/* Sticky scroll-to-bottom button — appears when user has scrolled up */}
        {userScrolledUp && stream.events.length > 0 && (
          <div className="sticky bottom-2 flex justify-center pointer-events-none">
            <button
              type="button"
              onClick={scrollToBottom}
              className="pointer-events-auto flex items-center gap-1.5 text-xs text-foreground/70 bg-[oklch(0.12_0_0)] hover:bg-[oklch(0.16_0_0)] border border-white/[0.12] hover:border-white/[0.20] rounded-full px-3 py-1.5 shadow-lg transition-all"
            >
              <ArrowDown className="size-3" />
              <span>Scroll to bottom</span>
            </button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Stop button + message input — sticky at bottom in page-scroll mode */}
      {!compact && (
        <div
          className={
            fullscreen
              ? 'shrink-0'
              : 'sticky bottom-0 rounded-b-xl bg-[oklch(0.085_0_0)]/95 backdrop-blur-sm border-t border-white/[0.05]'
          }
        >
          {/* Stop button — soft interrupt, only when agent is actively running */}
          {isActive && (
            <div className="flex justify-center px-3 pt-1.5">
              <button
                type="button"
                onClick={() => void handleInterrupt()}
                disabled={isInterrupting}
                className="flex items-center gap-1.5 text-xs text-amber-400/70 hover:text-amber-300 hover:bg-amber-500/10 border border-amber-500/15 hover:border-amber-500/30 rounded-md px-3 py-1 transition-colors disabled:opacity-40"
                aria-label="Stop current agent action"
              >
                {isInterrupting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Square className="size-3 fill-current" />
                )}
                Stop
              </button>
            </div>
          )}
          <SessionMessageInput
            sessionId={sessionId}
            status={currentStatus as SessionStatus}
            onSent={handleSent}
            slashCommands={slashCommands}
            mcpServers={mcpServers}
            agentBinaryPath={agentBinaryPath}
            neverStarted={currentStatus === 'idle' && stream.events.length === 0}
          />
        </div>
      )}
    </div>
  );
}
