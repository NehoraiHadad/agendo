'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
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
  Square,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '@/components/ui/copy-button';
import { WriteView } from '@/components/executions/tool-views/write-view';
import { EditView } from '@/components/executions/tool-views/edit-view';
import { MultiEditView } from '@/components/executions/tool-views/multi-edit-view';
import { SessionMessageInput } from '@/components/sessions/session-message-input';
import { ToolApprovalCard } from '@/components/sessions/tool-approval-card';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';
import type { UseSessionStreamReturn } from '@/hooks/use-session-stream';

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

interface ToolCallResult {
  content: string;
  isError: boolean;
}

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
// ToolCard — collapsible card for tool calls
// ---------------------------------------------------------------------------

interface ToolState {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: ToolCallResult;
}

function ToolCard({ tool }: { tool: ToolState }) {
  const hasResult = tool.result !== undefined;
  const isError = tool.result?.isError ?? false;
  // Derive open state: auto-open while pending or on error, auto-close on success.
  // manualOpen overrides auto-behavior once the user explicitly toggles.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
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
      className={`rounded-md border text-xs ${
        isError ? 'border-red-500/20 bg-red-500/[0.06]' : 'border-white/[0.07] bg-white/[0.03]'
      }`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/5 rounded-md transition-colors"
        onClick={() => setManualOpen((v) => (v !== null ? !v : !open))}
        aria-expanded={open}
      >
        <Wrench className="size-3 shrink-0 text-muted-foreground/50" />
        <span className="font-mono text-foreground/90 font-medium">{tool.toolName}</span>
        {statusIcon}
        <span className="ml-auto text-muted-foreground/40">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
      </button>

      {open && (
        <div className="px-2.5 pb-2">
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
}

// ---------------------------------------------------------------------------
// Bubble components
// ---------------------------------------------------------------------------

function InfoPill({ text }: { text: string }) {
  return (
    <div className="flex justify-center my-1">
      <span className="text-xs text-muted-foreground/70 bg-white/[0.04] border border-white/[0.05] px-3 py-0.5 rounded-full">
        {text}
      </span>
    </div>
  );
}

function TurnCompletePill({
  text,
  costUsd,
  sessionCostUsd,
}: {
  text: string;
  costUsd: number | null;
  sessionCostUsd: number | null;
}) {
  const [open, setOpen] = useState(false);
  const hasCost = costUsd !== null;
  return (
    <div className="flex flex-col items-center my-1 gap-1">
      <button
        type="button"
        onClick={() => hasCost && setOpen((v) => !v)}
        className={`text-xs text-muted-foreground/70 bg-white/[0.04] border border-white/[0.05] px-3 py-0.5 rounded-full transition-colors ${
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

function AssistantBubble({ parts }: { parts: AssistantPart[] }) {
  return (
    <div className="flex gap-2 items-start w-full">
      <div className="mt-1 flex-shrink-0 rounded-full bg-white/[0.06] border border-white/[0.08] p-1.5">
        <Bot className="size-3.5 text-muted-foreground" />
      </div>
      <div className="space-y-1.5 min-w-0 flex-1">
        {parts.map((part, i) =>
          part.kind === 'text' ? (
            <div
              key={i}
              className="rounded-lg bg-white/[0.04] text-foreground border border-white/[0.05] px-3 py-2 text-sm break-words overflow-x-auto leading-relaxed"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {part.text}
              </ReactMarkdown>
            </div>
          ) : (
            <ToolCard key={part.tool.toolUseId} tool={part.tool} />
          ),
        )}
      </div>
    </div>
  );
}

function ThinkingBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2 items-start w-full">
      <div className="mt-1 flex-shrink-0 rounded-full bg-white/[0.06] border border-white/[0.08] p-1.5">
        <Bot className="size-3.5 text-muted-foreground/50" />
      </div>
      <div className="rounded-md border border-white/[0.06] bg-white/[0.02] text-xs w-full">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/5 rounded-md transition-colors text-muted-foreground/50"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="italic">Thinking…</span>
          <span className="ml-auto">
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </span>
        </button>
        {open && (
          <div className="px-2.5 pb-2 text-muted-foreground/60 whitespace-pre-wrap break-words text-xs font-mono">
            {text}
          </div>
        )}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2 items-start justify-end">
      <div
        dir="auto"
        className="rounded-2xl rounded-tr-sm bg-primary/15 border border-primary/20 text-foreground ml-auto px-4 py-2 text-sm max-w-[85%] whitespace-pre-wrap break-words"
      >
        {text}
      </div>
      <div className="mt-1 flex-shrink-0 rounded-full bg-primary/10 border border-primary/20 p-1.5">
        <User className="size-3.5 text-primary" />
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2 items-start">
      <div className="mt-1 flex-shrink-0 rounded-full bg-white/[0.06] border border-white/[0.08] p-1.5">
        <Bot className="size-3.5 text-muted-foreground" />
      </div>
      <div className="rounded-lg bg-white/[0.04] px-3 py-2.5 flex gap-1 items-center">
        <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse" />
        <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse [animation-delay:150ms]" />
        <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse [animation-delay:300ms]" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display item types and build logic
// ---------------------------------------------------------------------------

type AssistantPart = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolState };

type DisplayItem =
  | { kind: 'assistant'; id: number; parts: AssistantPart[] }
  | {
      kind: 'turn-complete';
      id: number;
      text: string;
      costUsd: number | null;
      sessionCostUsd: number | null;
    }
  | { kind: 'thinking'; id: number; text: string }
  | { kind: 'user'; id: number; text: string }
  | { kind: 'info'; id: number; text: string }
  | { kind: 'error'; id: number; text: string }
  | {
      kind: 'tool-approval';
      id: number;
      approvalId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      dangerLevel: number;
    };

/** Extract displayable text from a tool result content value.
 *  MCP tools return content as an array of content blocks: [{type:'text',text:'...'}].
 *  Plain string content is used as-is. Anything else falls back to JSON.stringify. */
function extractToolContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const texts = raw
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join('\n');
  }
  return JSON.stringify(raw ?? '');
}

function buildToolResultMap(events: AgendoEvent[]): Map<string, ToolCallResult> {
  const map = new Map<string, ToolCallResult>();
  for (const ev of events) {
    if (ev.type === 'agent:tool-end') {
      map.set(ev.toolUseId, { content: extractToolContent(ev.content), isError: false });
    }
  }
  return map;
}

function buildDisplayItems(
  events: AgendoEvent[],
  toolResultMap: Map<string, ToolCallResult>,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  // Track pending tool calls so we can hydrate them with results as they arrive
  const pendingTools = new Map<string, ToolState>();
  let sessionInitCount = 0;
  let sessionCostUsd = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'agent:text': {
        const last = items[items.length - 1];
        if (last && last.kind === 'assistant') {
          // Append to existing text part if the last part is already text
          const lastPart = last.parts[last.parts.length - 1];
          if (lastPart && lastPart.kind === 'text') {
            lastPart.text += ev.text;
          } else {
            last.parts.push({ kind: 'text', text: ev.text });
          }
        } else {
          items.push({ kind: 'assistant', id: ev.id, parts: [{ kind: 'text', text: ev.text }] });
        }
        break;
      }

      case 'agent:thinking': {
        items.push({ kind: 'thinking', id: ev.id, text: ev.text });
        break;
      }

      case 'agent:tool-start': {
        const result = toolResultMap.get(ev.toolUseId);
        const toolState: ToolState = {
          toolUseId: ev.toolUseId,
          toolName: ev.toolName,
          input: ev.input,
          result,
        };
        pendingTools.set(ev.toolUseId, toolState);

        // Append tool part in order within the current assistant bubble
        const last = items[items.length - 1];
        if (last && last.kind === 'assistant') {
          last.parts.push({ kind: 'tool', tool: toolState });
        } else {
          items.push({ kind: 'assistant', id: ev.id, parts: [{ kind: 'tool', tool: toolState }] });
        }
        break;
      }

      case 'agent:tool-end': {
        const pending = pendingTools.get(ev.toolUseId);
        if (pending) {
          pending.result = { content: extractToolContent(ev.content), isError: false };
          pendingTools.delete(ev.toolUseId);
        }
        break;
      }

      case 'agent:tool-approval': {
        items.push({
          kind: 'tool-approval',
          id: ev.id,
          approvalId: ev.approvalId,
          toolName: ev.toolName,
          toolInput: ev.toolInput,
          dangerLevel: ev.dangerLevel,
        });
        break;
      }

      case 'agent:result': {
        const parts: string[] = ['Turn complete'];
        if (ev.turns != null) parts.push(`${ev.turns} turn${ev.turns !== 1 ? 's' : ''}`);
        if (ev.durationMs != null) parts.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
        if (ev.costUsd != null) sessionCostUsd += ev.costUsd;
        items.push({
          kind: 'turn-complete',
          id: ev.id,
          text: parts.join(' · '),
          costUsd: ev.costUsd ?? null,
          sessionCostUsd: ev.costUsd != null ? sessionCostUsd : null,
        });
        break;
      }

      case 'session:init': {
        sessionInitCount++;
        if (sessionInitCount === 1) {
          items.push({ kind: 'info', id: ev.id, text: 'Session started' });
        }
        break;
      }

      case 'user:message': {
        items.push({ kind: 'user', id: ev.id, text: ev.text });
        break;
      }

      case 'system:info': {
        items.push({ kind: 'info', id: ev.id, text: ev.message });
        break;
      }

      case 'system:error': {
        items.push({ kind: 'error', id: ev.id, text: ev.message });
        break;
      }

      // session:state and agent:activity are handled by the hook, not rendered here
      default:
        break;
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SessionChatViewProps {
  sessionId: string;
  stream: UseSessionStreamReturn;
  currentStatus: SessionStatus | null | string;
}

export function SessionChatView({ sessionId, stream, currentStatus }: SessionChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<{ id: string; text: string }[]>([]);
  const [resolvedApprovals, setResolvedApprovals] = useState<Set<string>>(new Set());
  const [isInterrupting, setIsInterrupting] = useState(false);
  const msgIdRef = useRef(0);

  const handleInterrupt = useCallback(async () => {
    if (isInterrupting) return;
    setIsInterrupting(true);
    try {
      await fetch(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
    } finally {
      setIsInterrupting(false);
    }
  }, [sessionId, isInterrupting]);

  const handleSent = useCallback((text: string) => {
    setOptimisticMessages((prev) => [...prev, { id: String(++msgIdRef.current), text }]);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stream.events.length, optimisticMessages.length]);

  const toolResultMap = buildToolResultMap(stream.events);
  const displayItems = buildDisplayItems(stream.events, toolResultMap);

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

  function renderDisplayItem(item: DisplayItem, idx: number): React.ReactNode {
    switch (item.kind) {
      case 'assistant':
        return <AssistantBubble key={idx} parts={item.parts} />;
      case 'thinking':
        return <ThinkingBubble key={idx} text={item.text} />;
      case 'user':
        return <UserBubble key={idx} text={item.text} />;
      case 'turn-complete':
        return (
          <TurnCompletePill
            key={idx}
            text={item.text}
            costUsd={item.costUsd}
            sessionCostUsd={item.sessionCostUsd}
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
            approvalId={item.approvalId}
            toolName={item.toolName}
            toolInput={item.toolInput}
            dangerLevel={item.dangerLevel}
            onResolved={() => handleApprovalResolved(item.approvalId)}
          />
        );
      }
    }
  }

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-[oklch(0.06_0_0)]'
          : 'flex flex-col rounded-xl border border-white/[0.07]'
      }
    >
      {/* Header */}
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

      {/* Chat area */}
      <div
        className={
          fullscreen
            ? 'flex-1 overflow-y-auto overflow-x-hidden bg-[oklch(0.07_0_0)] p-3 sm:p-4 space-y-3'
            : 'h-[55dvh] min-h-[280px] sm:h-[50dvh] sm:min-h-[320px] overflow-y-auto overflow-x-hidden bg-[oklch(0.07_0_0)] p-3 sm:p-4 space-y-3'
        }
        role="log"
        aria-live="polite"
        aria-label="Session chat"
      >
        {stream.events.length === 0 && !stream.error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground/60">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-xs">
              {stream.isConnected ? 'Waiting for agent…' : 'Connecting…'}
            </span>
          </div>
        )}

        {displayItems.map((item, i) => renderDisplayItem(item, i))}

        {/* Optimistic user messages shown while real event is in-flight */}
        {optimisticMessages.map((msg) => (
          <UserBubble key={`opt-${msg.id}`} text={msg.text} />
        ))}

        {showTyping && <TypingIndicator />}

        {stream.error && <ErrorPill text={`Stream error: ${stream.error}`} />}

        <div ref={bottomRef} />
      </div>

      {/* Stop button — soft interrupt, only when agent is actively running */}
      {isActive && (
        <div className="flex justify-center px-3 py-1.5 border-t border-white/[0.05] bg-[oklch(0.085_0_0)]">
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
      />
    </div>
  );
}
