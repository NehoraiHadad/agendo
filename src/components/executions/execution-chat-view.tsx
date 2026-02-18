'use client';

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { Bot, AlertTriangle, User, Wrench, ChevronDown, ChevronRight, Check, Loader2, Maximize2, Minimize2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UseExecutionStreamReturn } from '@/hooks/use-execution-stream';
import type { RenderedLine } from '@/lib/log-renderer';
import { ExecutionMessageInput, type ResumeContext } from './execution-message-input';
import { CopyButton } from '@/components/ui/copy-button';
import { WriteView } from '@/components/executions/tool-views/write-view';
import { EditView } from '@/components/executions/tool-views/edit-view';
import { MultiEditView } from '@/components/executions/tool-views/multi-edit-view';
import type { ExecutionStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Claude stream-json parsing
// ---------------------------------------------------------------------------

interface ClaudeTextBlock {
  type: 'text';
  text: string;
}
interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
}
type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;

type ToolCallResult = { content: string; isError: boolean };

type AssistantToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolCallResult;
};

type DisplayEvent =
  | {
      kind: 'assistant';
      text: string;
      toolCalls: AssistantToolCall[];
      id: number;
    }
  | { kind: 'info'; text: string; id: number }
  | { kind: 'error_msg'; text: string; id: number }
  | { kind: 'raw'; html: string; text: string; id: number };

function parseClaudeLine(
  line: RenderedLine,
  toolResultMap: Map<string, ToolCallResult>,
): DisplayEvent | null {
  if (line.stream === 'system') {
    return line.text.trim() ? { kind: 'info', text: line.text, id: line.id } : null;
  }

  if (line.stream === 'stderr') {
    return line.text.trim() ? { kind: 'error_msg', text: line.text, id: line.id } : null;
  }

  // User messages are shown via optimistic UserBubble (onSent) or frozen segment (resume).
  // Skip log-recorded user lines to avoid duplicate bubbles.
  if (line.stream === 'user') {
    return null;
  }

  const raw = line.text.trim();
  if (!raw) return null;

  // Claude Code --verbose mode prefixes MCP output with "/mcp[stdout] " or "/mcp[stderr] ".
  // Strip that internal prefix before parsing so the JSON is reachable.
  const text = raw.replace(/^\/\w+\[(?:stdout|stderr)\]\s*/, '');

  if (!text.startsWith('{')) {
    return { kind: 'raw', html: line.html, text: line.text, id: line.id };
  }

  try {
    const event = JSON.parse(text) as { type: string; [k: string]: unknown };

    if (event.type === 'assistant') {
      const content = (event.message as { content?: ClaudeContentBlock[] })?.content ?? [];
      const textBlocks = content.filter((b): b is ClaudeTextBlock => b.type === 'text');
      const toolUseBlocks = content.filter((b): b is ClaudeToolUseBlock => b.type === 'tool_use');
      const combinedText = textBlocks.map((b) => b.text).join('');
      const toolCalls: AssistantToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input,
        result: toolResultMap.get(b.id),
      }));
      if (!combinedText && toolCalls.length === 0) return null;
      return { kind: 'assistant', text: combinedText, toolCalls, id: line.id };
    }

    if (event.type === 'system') {
      const subtype = event.subtype as string | undefined;
      if (subtype === 'init') {
        const model = (event.model as string | undefined) ?? '';
        return { kind: 'info', text: `Session started${model ? ` · ${model}` : ''}`, id: line.id };
      }
      return null;
    }

    if (event.type === 'result') {
      const subtype = event.subtype as string | undefined;
      if (subtype === 'success') {
        const cost = event.total_cost_usd as number | undefined;
        const turns = event.num_turns as number | undefined;
        const durationMs = event.duration_ms as number | undefined;
        const parts: string[] = ['✓ Turn complete'];
        if (turns != null) parts.push(`${turns} turn${turns !== 1 ? 's' : ''}`);
        if (durationMs != null) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
        if (cost != null) parts.push(`$${cost.toFixed(4)}`);
        return { kind: 'info', text: parts.join(' · '), id: line.id };
      }
      const label = subtype?.replace(/_/g, ' ') ?? 'error';
      return { kind: 'error_msg', text: `⚠ ${label}`, id: line.id };
    }

    return null;
  } catch {
    return { kind: 'raw', html: line.html, text: line.text, id: line.id };
  }
}

// ---------------------------------------------------------------------------
// ToolOutput — native viewers per tool type
// ---------------------------------------------------------------------------

function ToolOutput({ name, result }: { name: string; result: ToolCallResult }) {
  const { content, isError } = result;
  if (!content) return null;

  const truncated = content.length > 800 ? content.slice(0, 800) + '\n…(truncated)' : content;
  const baseClass = 'text-xs font-mono whitespace-pre-wrap break-all overflow-auto rounded p-2 mt-1 pr-8';

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

function ToolCard({ tc }: { tc: AssistantToolCall }) {
  const hasResult = tc.result !== undefined;
  const isError = tc.result?.isError ?? false;
  const [open, setOpen] = useState(!hasResult || isError);

  useEffect(() => {
    if (hasResult && !isError) {
      setOpen(false);
    }
  }, [hasResult, isError]);

  const statusIcon = !hasResult ? (
    <Loader2 className="size-3 text-zinc-400 animate-spin" />
  ) : isError ? (
    <span className="text-red-400 text-xs">✗</span>
  ) : (
    <Check className="size-3 text-emerald-400" />
  );

  const inputStr = Object.keys(tc.input).length > 0 ? JSON.stringify(tc.input, null, 2) : null;

  return (
    <div className={`rounded-md border text-xs ${isError ? 'border-red-500/20 bg-red-500/[0.06]' : 'border-white/[0.07] bg-white/[0.03]'}`}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/5 rounded-md transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Wrench className="size-3 shrink-0 text-muted-foreground/50" />
        <span className="font-mono text-foreground/90 font-medium">{tc.name}</span>
        {statusIcon}
        <span className="ml-auto text-muted-foreground/40">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
      </button>

      {open && (
        <div className="px-2.5 pb-2">
          {tc.name === 'Write' || tc.name === 'CreateFile' ? (
            <WriteView
              input={
                tc.input as {
                  content?: string;
                  new_file?: string;
                  path?: string;
                  file_path?: string;
                }
              }
            />
          ) : tc.name === 'Edit' || tc.name === 'str_replace_editor' ? (
            <EditView
              input={
                tc.input as {
                  old_string?: string;
                  new_string?: string;
                  path?: string;
                  file_path?: string;
                }
              }
            />
          ) : tc.name === 'MultiEdit' ? (
            <MultiEditView
              input={
                tc.input as {
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
              {tc.result && <ToolOutput name={tc.name} result={tc.result} />}
            </>
          )}
          {/* Show tool result for Write/Edit too */}
          {(tc.name === 'Write' ||
            tc.name === 'CreateFile' ||
            tc.name === 'Edit' ||
            tc.name === 'str_replace_editor' ||
            tc.name === 'MultiEdit') &&
            tc.result && (
              <div className="mt-1">
                <ToolOutput name={tc.name} result={tc.result} />
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
      <span className="text-xs text-muted-foreground/70 bg-white/[0.04] border border-white/[0.05] px-3 py-0.5 rounded-full">{text}</span>
    </div>
  );
}

function ErrorPill({ text }: { text: string }) {
  return (
    <div className="flex justify-center my-1">
      <span className="text-xs text-red-400 bg-red-500/[0.08] px-3 py-0.5 rounded-full border border-red-800/30">{text}</span>
    </div>
  );
}

const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => <p className="mb-1 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
  h1: ({ children }) => <h1 className="text-base font-bold text-foreground mb-1 mt-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-bold text-foreground mb-1 mt-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-foreground/90 mb-1 mt-1">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 my-1 text-foreground/80">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 my-1 text-foreground/80">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ children, className }) => {
    const isBlock = className?.startsWith('language-');
    const text = typeof children === 'string' ? children : String(children ?? '');
    return isBlock ? (
      <div className="relative my-1">
        <pre className="bg-black/50 rounded p-2 text-xs font-mono overflow-auto max-h-40 text-foreground/80 whitespace-pre pr-8"><code>{children}</code></pre>
        <CopyButton text={text} className="absolute top-1 right-1" />
      </div>
    ) : (
      <code className="bg-white/[0.08] rounded px-1 text-xs font-mono text-foreground/90">{children}</code>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 my-1 text-muted-foreground italic">{children}</blockquote>
  ),
  hr: () => <hr className="border-white/[0.08] my-2" />,
  a: ({ href, children }) => (
    <a href={href} className="text-primary underline hover:text-primary/80" target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

function AssistantBubble({ text, toolCalls }: { text: string; toolCalls: AssistantToolCall[] }) {
  return (
    <div className="flex gap-2 items-start max-w-[85%]">
      <div className="mt-1 flex-shrink-0 rounded-full bg-white/[0.06] border border-white/[0.08] p-1.5">
        <Bot className="size-3.5 text-muted-foreground" />
      </div>
      <div className="space-y-1.5 min-w-0 w-full">
        {text && (
          <div className="rounded-lg bg-white/[0.04] text-foreground border border-white/[0.05] px-3 py-2 text-sm break-words leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>
          </div>
        )}
        {toolCalls.map((tc) => (
          <ToolCard key={tc.id} tc={tc} />
        ))}
      </div>
    </div>
  );
}

function RawBubble({ html, text }: { html: string; text: string }) {
  void text;
  // html is pre-sanitized by DOMPurify in log-renderer.ts (ALLOWED_TAGS: span, ALLOWED_ATTR: style)
  // This is safe to render as inner HTML.
  const sanitizedHtml = html;
  return (
    <div className="flex gap-2 items-start max-w-[85%]">
      <div className="mt-1 flex-shrink-0 rounded-full bg-white/[0.06] border border-white/[0.08] p-1.5">
        <Bot className="size-3.5 text-muted-foreground" />
      </div>
      <div
        className="rounded-lg bg-white/[0.04] border border-white/[0.05] text-foreground px-3 py-2 text-sm font-mono whitespace-pre-wrap break-words"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    </div>
  );
}

function StderrBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2 items-start max-w-[85%]">
      <div className="mt-1 flex-shrink-0 rounded-full bg-amber-900/50 p-1.5">
        <AlertTriangle className="size-3.5 text-amber-400" />
      </div>
      <div className="rounded-lg bg-amber-500/[0.08] text-amber-200 border border-amber-500/20 px-3 py-2 text-sm font-mono whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2 items-start justify-end">
      <div className="rounded-2xl rounded-tr-sm bg-primary/15 border border-primary/20 text-foreground ml-auto px-4 py-2 text-sm max-w-[85%] whitespace-pre-wrap break-words">
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
// Main component
// ---------------------------------------------------------------------------

interface UserChatMessage {
  id: string;
  text: string;
  insertAfterLineIndex: number;
}

type RenderItem =
  | { kind: 'event'; event: DisplayEvent }
  | { kind: 'user'; msg: UserChatMessage };

type FrozenSegment = RenderItem[];

function SessionDivider() {
  return (
    <div className="flex items-center gap-2 my-2 shrink-0">
      <div className="flex-1 h-px bg-white/[0.06]" />
      <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider px-1">Session continued</span>
      <div className="flex-1 h-px bg-white/[0.06]" />
    </div>
  );
}

interface ExecutionChatViewProps {
  executionId: string;
  stream: UseExecutionStreamReturn;
  currentStatus: ExecutionStatus;
  resumeContext?: ResumeContext;
  onResumed?: (newExecutionId: string) => void;
  onSessionRef?: (sessionRef: string) => void;
}

export function ExecutionChatView({ executionId, stream, currentStatus, resumeContext, onResumed, onSessionRef }: ExecutionChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [userMessages, setUserMessages] = useState<UserChatMessage[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [frozenSegments, setFrozenSegments] = useState<FrozenSegment[]>([]);
  const msgIdRef = useRef(0);
  const eventsLengthRef = useRef(0);
  const renderItemsRef = useRef<RenderItem[]>([]);

  const handleSent = useCallback((text: string) => {
    setUserMessages((prev) => [
      ...prev,
      {
        id: String(++msgIdRef.current),
        text,
        insertAfterLineIndex: eventsLengthRef.current,
      },
    ]);
  }, []);

  // When resumed: freeze current render items (appending user's trigger message),
  // reset user messages, then switch to the new execution.
  const handleResumed = useCallback((newId: string, userText: string) => {
    const currentItems: RenderItem[] = [
      ...renderItemsRef.current,
      {
        kind: 'user',
        msg: { id: String(++msgIdRef.current), text: userText, insertAfterLineIndex: Infinity },
      },
    ];
    setFrozenSegments((prev) => [...prev, currentItems]);
    setUserMessages([]);
    onResumed?.(newId);
  }, [onResumed]);

  // Two-pass parsing:
  // Pass 1 — collect tool results + slash_commands + session_id from system init
  // Pass 2 — parse assistant events with result lookup
  const { events, sessionSlashCommands, sessionId } = useMemo(() => {
    const toolResultMap = new Map<string, ToolCallResult>();
    let slashCmds: string[] = [];
    let sessionId: string | null = null;

    for (const line of stream.lines) {
      if (line.stream !== 'stdout') continue;
      const t = line.text.trim().replace(/^\/\w+\[(?:stdout|stderr)\]\s*/, '');
      if (!t.startsWith('{')) continue;
      try {
        const ev = JSON.parse(t) as {
          type?: string;
          subtype?: string;
          session_id?: string;
          slash_commands?: string[];
          message?: { content?: ClaudeContentBlock[] };
        };
        // Collect tool results
        if (ev.type === 'user') {
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'tool_result') {
              const content =
                typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? (block.content as Array<{ type: string; text?: string }>)
                        .filter((b) => b.type === 'text')
                        .map((b) => b.text ?? '')
                        .join('')
                    : '';
              toolResultMap.set(block.tool_use_id, {
                content,
                isError: block.is_error ?? false,
              });
            }
          }
        }
        // Extract session_id + slash_commands from system init
        if (ev.type === 'system' && ev.subtype === 'init') {
          if (Array.isArray(ev.slash_commands)) slashCmds = ev.slash_commands;
          if (ev.session_id) sessionId = ev.session_id;
        }
      } catch {
        // not JSON, skip
      }
    }

    // Pass 2: parse events with result lookup
    const parsedEvents = stream.lines.flatMap((line) => {
      const event = parseClaudeLine(line, toolResultMap);
      return event ? [event] : [];
    });

    return { events: parsedEvents, sessionSlashCommands: slashCmds, sessionId };
  }, [stream.lines]);

  // Notify parent of session ref from the live stream (enables chained resumes)
  useEffect(() => {
    if (sessionId) onSessionRef?.(sessionId);
  }, [sessionId, onSessionRef]);

  // Keep eventsLengthRef in sync so handleSent captures the right index
  eventsLengthRef.current = events.length;

  // Interleave optimistic user messages by their line index
  const renderItems = useMemo(() => {
    const items: RenderItem[] = [];
    let linesCovered = 0;
    let userMsgIdx = 0;

    for (const event of events) {
      linesCovered += 1;

      while (
        userMsgIdx < userMessages.length &&
        userMessages[userMsgIdx].insertAfterLineIndex < linesCovered
      ) {
        items.push({ kind: 'user', msg: userMessages[userMsgIdx] });
        userMsgIdx++;
      }

      items.push({ kind: 'event', event });
    }

    while (userMsgIdx < userMessages.length) {
      items.push({ kind: 'user', msg: userMessages[userMsgIdx] });
      userMsgIdx++;
    }

    return items;
  }, [events, userMessages]);

  // Keep ref in sync so handleResumed can capture current items without a stale closure
  renderItemsRef.current = renderItems;

  function renderItem(item: RenderItem, prefix: string) {
    if (item.kind === 'user') {
      return <UserBubble key={`${prefix}-user-${item.msg.id}`} text={item.msg.text} />;
    }
    const { event } = item;
    switch (event.kind) {
      case 'assistant':
        return <AssistantBubble key={`${prefix}-evt-${event.id}`} text={event.text} toolCalls={event.toolCalls} />;
      case 'info':
        return <InfoPill key={`${prefix}-evt-${event.id}`} text={event.text} />;
      case 'error_msg':
        return <StderrBubble key={`${prefix}-evt-${event.id}`} text={event.text} />;
      case 'raw':
        return <RawBubble key={`${prefix}-evt-${event.id}`} html={event.html} text={event.text} />;
    }
  }

  const showTyping = currentStatus === 'running' && stream.isConnected && !stream.isDone;
  const hasFrozen = frozenSegments.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length, userMessages.length]);

  return (
    <div className={fullscreen
      ? 'fixed inset-0 z-50 flex flex-col bg-[oklch(0.06_0_0)]'
      : 'flex flex-col rounded-xl border border-white/[0.07]'
    }>
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.07] shrink-0 bg-[oklch(0.09_0_0)] rounded-t-xl">
        <span className="text-xs text-muted-foreground/50">Chat</span>
        <button
          type="button"
          onClick={() => setFullscreen((v) => !v)}
          className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      </div>
      <div
        className={fullscreen
          ? 'flex-1 overflow-auto bg-[oklch(0.07_0_0)] p-3 sm:p-4 space-y-3'
          : 'h-[55dvh] min-h-[280px] sm:h-[50dvh] sm:min-h-[320px] overflow-auto bg-[oklch(0.07_0_0)] p-3 sm:p-4 space-y-3'
        }
        role="log"
        aria-live="polite"
        aria-label="Execution chat"
      >
        {!hasFrozen && events.length === 0 && !stream.error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground/60">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-xs">{stream.isConnected ? 'Waiting for agent output…' : 'Connecting…'}</span>
          </div>
        )}

        {frozenSegments.map((segment, segIdx) => (
          <div key={segIdx}>
            {segment.map((item) => renderItem(item, `frozen-${segIdx}`))}
            <SessionDivider />
          </div>
        ))}

        {renderItems.map((item) => renderItem(item, 'cur'))}

        {showTyping && <TypingIndicator />}

        {stream.error && <ErrorPill text={`Stream error: ${stream.error}`} />}

        <div ref={bottomRef} />
      </div>

      <ExecutionMessageInput
        executionId={executionId}
        status={currentStatus}
        onSent={handleSent}
        sessionSlashCommands={sessionSlashCommands}
        resumeContext={resumeContext}
        onResumed={handleResumed}
      />
    </div>
  );
}
