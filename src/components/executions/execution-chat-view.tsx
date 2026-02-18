'use client';

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { Bot, AlertTriangle, User, Wrench, ChevronDown, ChevronRight, Check, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UseExecutionStreamReturn } from '@/hooks/use-execution-stream';
import type { RenderedLine } from '@/lib/log-renderer';
import { ExecutionMessageInput } from './execution-message-input';
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
        colorClass = 'bg-zinc-950 text-green-300 max-h-48';
        break;
      case 'Read':
        colorClass = 'bg-zinc-950 text-blue-200 max-h-48';
        break;
      case 'Glob':
      case 'Grep':
        colorClass = 'bg-zinc-950 text-zinc-300 max-h-32';
        break;
      default:
        colorClass = 'bg-zinc-900 text-zinc-400 max-h-24';
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
    <div className={`rounded-md border text-xs ${isError ? 'border-red-800/50 bg-red-950/20' : 'border-zinc-700 bg-zinc-900'}`}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/5 rounded-md transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Wrench className="size-3 shrink-0 text-zinc-500" />
        <span className="font-mono text-zinc-200 font-medium">{tc.name}</span>
        {statusIcon}
        <span className="ml-auto text-zinc-600">
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
                <pre className="text-xs font-mono whitespace-pre-wrap break-all text-zinc-400 bg-zinc-950 rounded p-2 overflow-auto max-h-32">
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
      <span className="text-xs text-muted-foreground bg-muted px-3 py-0.5 rounded-full">{text}</span>
    </div>
  );
}

function ErrorPill({ text }: { text: string }) {
  return (
    <div className="flex justify-center my-1">
      <span className="text-xs text-red-400 bg-red-500/10 px-3 py-0.5 rounded-full border border-red-800/30">{text}</span>
    </div>
  );
}

const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => <p className="mb-1 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
  em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
  h1: ({ children }) => <h1 className="text-base font-bold text-zinc-100 mb-1 mt-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-bold text-zinc-100 mb-1 mt-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-zinc-200 mb-1 mt-1">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 my-1 text-zinc-300">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 my-1 text-zinc-300">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ children, className }) => {
    const isBlock = className?.startsWith('language-');
    const text = typeof children === 'string' ? children : String(children ?? '');
    return isBlock ? (
      <div className="relative my-1">
        <pre className="bg-zinc-950 rounded p-2 text-xs font-mono overflow-auto max-h-40 text-zinc-300 whitespace-pre pr-8"><code>{children}</code></pre>
        <CopyButton text={text} className="absolute top-1 right-1" />
      </div>
    ) : (
      <code className="bg-zinc-700 rounded px-1 text-xs font-mono text-zinc-200">{children}</code>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-zinc-600 pl-3 my-1 text-zinc-400 italic">{children}</blockquote>
  ),
  hr: () => <hr className="border-zinc-700 my-2" />,
  a: ({ href, children }) => (
    <a href={href} className="text-blue-400 underline hover:text-blue-300" target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

function AssistantBubble({ text, toolCalls }: { text: string; toolCalls: AssistantToolCall[] }) {
  return (
    <div className="flex gap-2 items-start max-w-[85%]">
      <div className="mt-1 flex-shrink-0 rounded-full bg-zinc-700 p-1.5">
        <Bot className="size-3.5 text-zinc-300" />
      </div>
      <div className="space-y-1.5 min-w-0 w-full">
        {text && (
          <div className="rounded-lg bg-zinc-800 text-zinc-100 px-3 py-2 text-sm break-words leading-relaxed">
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
      <div className="mt-1 flex-shrink-0 rounded-full bg-zinc-700 p-1.5">
        <Bot className="size-3.5 text-zinc-300" />
      </div>
      <div
        className="rounded-lg bg-zinc-800 text-zinc-100 px-3 py-2 text-sm font-mono whitespace-pre-wrap break-words"
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
      <div className="rounded-lg bg-amber-950/50 text-amber-200 border border-amber-800/50 px-3 py-2 text-sm font-mono whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2 items-start justify-end">
      <div className="rounded-lg bg-primary text-primary-foreground ml-auto px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap break-words">
        {text}
      </div>
      <div className="mt-1 flex-shrink-0 rounded-full bg-primary/20 p-1.5">
        <User className="size-3.5 text-primary" />
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2 items-start">
      <div className="mt-1 flex-shrink-0 rounded-full bg-zinc-700 p-1.5">
        <Bot className="size-3.5 text-zinc-300" />
      </div>
      <div className="rounded-lg bg-zinc-800 px-3 py-2.5 flex gap-1 items-center">
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

interface ExecutionChatViewProps {
  executionId: string;
  stream: UseExecutionStreamReturn;
  currentStatus: ExecutionStatus;
}

export function ExecutionChatView({ executionId, stream, currentStatus }: ExecutionChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [userMessages, setUserMessages] = useState<UserChatMessage[]>([]);
  const msgIdRef = useRef(0);

  const handleSent = useCallback(
    (text: string) => {
      setUserMessages((prev) => [
        ...prev,
        {
          id: String(++msgIdRef.current),
          text,
          insertAfterLineIndex: stream.lines.length,
        },
      ]);
    },
    [stream.lines.length],
  );

  // Two-pass parsing:
  // Pass 1 — collect tool results + slash_commands from system init
  // Pass 2 — parse assistant events with result lookup
  const { events, sessionSlashCommands } = useMemo(() => {
    const toolResultMap = new Map<string, ToolCallResult>();
    let slashCmds: string[] = [];

    for (const line of stream.lines) {
      if (line.stream !== 'stdout') continue;
      const t = line.text.trim().replace(/^\/\w+\[(?:stdout|stderr)\]\s*/, '');
      if (!t.startsWith('{')) continue;
      try {
        const ev = JSON.parse(t) as {
          type?: string;
          subtype?: string;
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
        // Extract slash_commands from system init (take the last one seen)
        if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.slash_commands)) {
          slashCmds = ev.slash_commands;
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

    return { events: parsedEvents, sessionSlashCommands: slashCmds };
  }, [stream.lines]);

  // Interleave optimistic user messages by their line index
  const renderItems = useMemo(() => {
    type Item =
      | { kind: 'event'; event: DisplayEvent }
      | { kind: 'user'; msg: UserChatMessage };

    const items: Item[] = [];
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

  const showTyping = currentStatus === 'running' && stream.isConnected && !stream.isDone;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length, userMessages.length]);

  return (
    <div className="flex flex-col rounded-md border border-zinc-700">
      <div
        className="h-[50dvh] min-h-[320px] overflow-auto bg-zinc-950 p-4 space-y-3"
        role="log"
        aria-live="polite"
        aria-label="Execution chat"
      >
        {events.length === 0 && !stream.error && (
          <div className="flex h-full items-center justify-center text-zinc-500 text-sm">
            {stream.isConnected ? 'Waiting for agent output...' : 'Connecting...'}
          </div>
        )}

        {renderItems.map((item) => {
          if (item.kind === 'user') {
            return <UserBubble key={`user-${item.msg.id}`} text={item.msg.text} />;
          }

          const { event } = item;
          switch (event.kind) {
            case 'assistant':
              return (
                <AssistantBubble
                  key={`evt-${event.id}`}
                  text={event.text}
                  toolCalls={event.toolCalls}
                />
              );
            case 'info':
              return <InfoPill key={`evt-${event.id}`} text={event.text} />;
            case 'error_msg':
              return <StderrBubble key={`evt-${event.id}`} text={event.text} />;
            case 'raw':
              return <RawBubble key={`evt-${event.id}`} html={event.html} text={event.text} />;
          }
        })}

        {showTyping && <TypingIndicator />}

        {stream.error && <ErrorPill text={`Stream error: ${stream.error}`} />}

        <div ref={bottomRef} />
      </div>

      <ExecutionMessageInput
        executionId={executionId}
        status={currentStatus}
        onSent={handleSent}
        sessionSlashCommands={sessionSlashCommands}
      />
    </div>
  );
}
