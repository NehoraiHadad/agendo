'use client';

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  memo,
  createContext,
  useContext,
} from 'react';
import { useRouter } from 'next/navigation';
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
  Pencil,
  Cpu,
  Clock,
  DollarSign,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '@/components/ui/copy-button';
import { WriteView } from '@/components/executions/tool-views/write-view';
import { EditView } from '@/components/executions/tool-views/edit-view';
import { MultiEditView } from '@/components/executions/tool-views/multi-edit-view';
import { buildMessageFormData } from '@/components/sessions/session-message-attachments';
import {
  SessionMessageInput,
  type PendingAttachment,
  type QueuedAttachmentPayload,
} from '@/components/sessions/session-message-input';
import { PendingMessagePill } from '@/components/sessions/pending-message-pill';
import { ToolApprovalCard } from '@/components/sessions/tool-approval-card';
import { InteractiveTool } from '@/components/sessions/interactive-tools';
import { hasTaskNotifications, parseTaskNotifications } from '@/lib/utils/task-notification-parser';
import { TaskNotificationCard } from '@/components/sessions/task-notification-card';
import { ArtifactCard } from '@/components/sessions/artifact-card';
import { deriveProvider } from '@/lib/utils/session-controls';
import { apiFetch } from '@/lib/api-types';
import { generateId } from '@/lib/utils';
import type { SessionStatus } from '@/lib/realtime/events';

// Module-level set keeps the early-return guard in ToolCard stable and avoids
// creating a dynamic component reference during render (react-hooks/static-components).
// Keep in sync with the TOOL_RENDERERS registry in interactive-tools.tsx.
const INTERACTIVE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

// Context that propagates agentSlug to ToolCard without prop drilling through
// renderAssistantParts → ToolGroup → ToolCard.
const AgentSlugContext = createContext<string | undefined>(undefined);
import type { UseSessionStreamReturn } from '@/hooks/use-session-stream';
import {
  buildDisplayItems,
  buildToolResultMap,
  type ToolCallResult,
  type ToolState,
  type AssistantPart,
  type DisplayItem,
  type DisplayAttachment,
  type TurnMeta,
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
// Guide marker parser — extracts [GUIDE: step1 → step2] from agent text
// ---------------------------------------------------------------------------

function parseGuideMarker(text: string): string[] | null {
  const match = text.match(/\[GUIDE:\s*(.+?)\]/);
  if (!match) return null;
  return match[1]
    .split('→')
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripGuideMarkers(text: string): string {
  return text.replace(/\[GUIDE:\s*.+?\]\n?/g, '');
}

function GuideBreadcrumb({ steps }: { steps: string[] }) {
  return (
    <div className="flex items-center gap-1 flex-wrap mt-2 mb-0.5">
      {steps.map((step, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
          <span className="text-xs font-medium text-primary/90 bg-primary/10 rounded px-1.5 py-0.5">
            {step}
          </span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message timestamp formatter
// ---------------------------------------------------------------------------

function formatMessageTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 60_000) return 'just now';
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return (
    date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

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
  // Agent slug from context — drives ArtifactCard accent color.
  const agentSlug = useContext(AgentSlugContext);

  // render_artifact: when the tool has a successful result, render ArtifactCard.
  // Match both bare name (from MCP server) and namespaced name (from Claude Code: mcp__agendo__render_artifact).
  const isRenderArtifact =
    tool.toolName === 'render_artifact' || tool.toolName.endsWith('__render_artifact');

  // Still executing — show loading skeleton immediately so the user knows it's happening.
  if (isRenderArtifact && !tool.result) {
    return <ArtifactCard title="Generating artifact…" agentSlug={agentSlug} isLoading />;
  }

  if (isRenderArtifact && tool.result && !tool.result.isError) {
    let artifact: { id: string; title: string; type: 'html' | 'svg' } | null = null;
    try {
      artifact = JSON.parse(tool.result.content) as {
        id: string;
        title: string;
        type: 'html' | 'svg';
      };
    } catch {
      // invalid JSON — fall through to default tool rendering
    }
    if (artifact) {
      return (
        <ArtifactCard
          artifactId={artifact.id}
          title={artifact.title}
          artifactType={artifact.type}
          toolResultText={tool.result.content}
          agentSlug={agentSlug}
        />
      );
    }
  }

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
  const isSubagent = !!tool.subagentInfo;

  const statusIcon = !hasResult ? (
    <Loader2 className="size-3 text-zinc-400 animate-spin" />
  ) : isError ? (
    <span className="text-red-400 text-xs">✗</span>
  ) : (
    <Check className="size-3 text-emerald-400" />
  );

  const inputStr = Object.keys(tool.input).length > 0 ? JSON.stringify(tool.input, null, 2) : null;

  // Subagent delegation card — visually distinct from regular tool calls
  if (isSubagent && tool.subagentInfo) {
    const { description, subagentType } = tool.subagentInfo;
    const label = subagentType ?? tool.toolName;
    // Prompt is the primary description of what was delegated
    const prompt =
      description ??
      (typeof tool.input.prompt === 'string' ? tool.input.prompt : null) ??
      (typeof tool.input.description === 'string' ? tool.input.description : null);
    const promptPreview = prompt
      ? prompt.length > 120
        ? prompt.slice(0, 120) + '…'
        : prompt
      : null;

    return (
      <div
        className={`rounded-lg text-xs overflow-hidden flex ${
          isError
            ? 'border border-red-500/20 bg-red-500/[0.04]'
            : 'border border-indigo-500/20 bg-[oklch(0.08_0.01_275)]'
        }`}
      >
        {/* Left accent rail — pulses while running */}
        <div
          className={`w-0.5 shrink-0 rounded-l-lg ${
            isError
              ? 'bg-red-500/50'
              : !hasResult
                ? 'bg-indigo-400/70 animate-pulse'
                : 'bg-indigo-500/50'
          }`}
        />

        <div className="flex-1 min-w-0">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-white/[0.03] transition-colors"
            onClick={() => setManualOpen((v) => (v !== null ? !v : !open))}
            aria-expanded={open}
          >
            <Cpu className="size-3 shrink-0 text-indigo-400/70" />
            <span className="font-mono text-[11px] text-indigo-200/80 font-medium tracking-tight">
              {label}
            </span>
            {/* Subagent badge */}
            <span className="inline-flex items-center rounded px-1 py-0 text-[9px] font-semibold uppercase tracking-widest bg-indigo-500/15 text-indigo-300/70 border border-indigo-500/20 leading-4">
              subagent
            </span>
            <span className="ml-1">{statusIcon}</span>
            {/* Description preview in header when collapsed */}
            {!open && promptPreview && (
              <span className="ml-1 text-muted-foreground/40 truncate text-[10px] font-normal max-w-[160px]">
                {promptPreview}
              </span>
            )}
            <span className="ml-auto text-muted-foreground/30">
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </span>
          </button>

          {open && (
            <div className="px-2.5 pb-2 border-t border-indigo-500/[0.08]">
              {promptPreview && (
                <p className="text-[10px] text-indigo-200/50 mt-1.5 mb-1 leading-relaxed">
                  {prompt}
                </p>
              )}
              {tool.result && <ToolOutput name={tool.toolName} result={tool.result} />}
            </div>
          )}
        </div>
      </div>
    );
  }

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

function CompactLoadingPill({ trigger }: { trigger: 'auto' | 'manual' }) {
  return (
    <div className="flex justify-center my-2">
      <span className="text-[11px] text-muted-foreground/60 bg-white/[0.03] border border-white/[0.06] px-3 py-0.5 rounded-full flex items-center gap-1.5 tracking-wide">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        {trigger === 'manual' ? 'Compacting context…' : 'Auto-compacting context…'}
      </span>
    </div>
  );
}

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
    <div className="group/turnpill flex flex-col items-center my-1 gap-1">
      <div className="flex items-center gap-1.5">
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
      </div>
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
      // Check for <task-notification> XML blocks in text
      if (hasTaskNotifications(part.text)) {
        const segments = parseTaskNotifications(part.text);
        for (let si = 0; si < segments.length; si++) {
          const seg = segments[si];
          if (seg.kind === 'notification') {
            result.push(
              <TaskNotificationCard key={`tn-${startIdx}-${si}`} notification={seg.notification} />,
            );
          } else {
            const guideSteps = parseGuideMarker(seg.content);
            const displayText = guideSteps ? stripGuideMarkers(seg.content) : seg.content;
            result.push(
              <div
                key={`t-${startIdx}-${si}`}
                className="group/textbubble relative rounded-2xl rounded-tl-sm bg-white/[0.04] text-foreground border border-white/[0.06] px-3.5 py-2.5 text-sm break-words overflow-x-auto leading-relaxed"
                style={{ borderLeft: '2px solid oklch(0.7 0.18 280 / 0.18)' }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {displayText}
                </ReactMarkdown>
                {guideSteps && <GuideBreadcrumb steps={guideSteps} />}
                <CopyButton
                  text={seg.content}
                  className="absolute top-1 right-1 opacity-0 group-hover/textbubble:opacity-100 transition-opacity"
                />
              </div>,
            );
          }
        }
      } else {
        const guideSteps = parseGuideMarker(part.text);
        const displayText = guideSteps ? stripGuideMarkers(part.text) : part.text;
        result.push(
          <div
            key={`t-${startIdx}`}
            className="group/textbubble relative rounded-2xl rounded-tl-sm bg-white/[0.04] text-foreground border border-white/[0.06] px-3.5 py-2.5 text-sm break-words overflow-x-auto leading-relaxed"
            style={{ borderLeft: '2px solid oklch(0.7 0.18 280 / 0.18)' }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {displayText}
            </ReactMarkdown>
            {guideSteps && <GuideBreadcrumb steps={guideSteps} />}
            <CopyButton
              text={part.text}
              className="absolute top-1 right-1 opacity-0 group-hover/textbubble:opacity-100 transition-opacity"
            />
          </div>,
        );
      }
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

/** Inline turn stats shown on click on the last assistant bubble of a turn. */
function TurnMetaPopover({ meta }: { meta: TurnMeta }) {
  const [open, setOpen] = useState(false);

  const stats: string[] = [];
  if (meta.turns != null) stats.push(`${meta.turns} turn${meta.turns !== 1 ? 's' : ''}`);
  if (meta.durationMs != null) stats.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
  if (meta.durationApiMs != null && meta.durationMs != null && meta.durationMs > 0) {
    const pct = Math.round((meta.durationApiMs / meta.durationMs) * 100);
    stats.push(`${pct}% API`);
  }
  if (meta.webSearches > 0)
    stats.push(`${meta.webSearches} search${meta.webSearches > 1 ? 'es' : ''}`);
  if (meta.denials > 0) stats.push(`${meta.denials} denied`);

  return (
    <span className="inline-flex items-center gap-1 opacity-0 group-hover/assistantrow:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors pl-0.5"
        title="Turn stats"
      >
        <Clock className="size-2.5" />
        {meta.durationMs != null && <span>{(meta.durationMs / 1000).toFixed(1)}s</span>}
        {meta.costUsd != null && (
          <>
            <DollarSign className="size-2.5 ml-0.5" />
            <span>{meta.costUsd.toFixed(4)}</span>
          </>
        )}
      </button>
      {open && (
        <span className="inline-flex items-center bg-[oklch(0.12_0_0)] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[10px] text-muted-foreground/70 shadow-lg gap-x-3 gap-y-0.5 flex-wrap animate-fade-in-up">
          {stats.length > 0 && <span>{stats.join(' · ')}</span>}
          {meta.costUsd != null && (
            <span className="font-mono">turn ${meta.costUsd.toFixed(4)}</span>
          )}
          {meta.sessionCostUsd != null && (
            <span className="font-mono text-muted-foreground/50">
              session ${meta.sessionCostUsd.toFixed(4)}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function AssistantBubble({
  parts,
  sessionId,
  showAvatar = true,
  ts,
  turnMeta,
}: {
  parts: AssistantPart[];
  sessionId: string;
  showAvatar?: boolean;
  ts?: number;
  turnMeta?: TurnMeta;
}) {
  return (
    <div className="flex gap-2.5 items-start w-full animate-fade-in-up group/assistantrow">
      {/* Agent avatar — only shown on first in a consecutive run */}
      {showAvatar ? (
        <div className="mt-0.5 flex-shrink-0 rounded-lg bg-primary/[0.10] border border-primary/20 p-1.5 shadow-[0_0_8px_oklch(0.7_0.18_280/0.12)]">
          <Bot className="size-3.5 text-primary/80" />
        </div>
      ) : (
        <div className="mt-0.5 flex-shrink-0 w-[28px]" />
      )}
      <div className="space-y-1.5 min-w-0 flex-1">
        {renderAssistantParts(parts, sessionId)}
        <span className="flex items-center gap-2 min-h-[14px]">
          {ts && (
            <span className="text-[10px] text-muted-foreground/25 opacity-0 group-hover/assistantrow:opacity-100 transition-opacity pl-0.5">
              {formatMessageTime(ts)}
            </span>
          )}
          {turnMeta && <TurnMetaPopover meta={turnMeta} />}
        </span>
      </div>
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

// ---------------------------------------------------------------------------
// EditPopover — "Edit message" dialog attached to user messages
// ---------------------------------------------------------------------------

function BranchPopover({
  sessionId,
  branchUuid,
  originalText,
}: {
  sessionId: string;
  branchUuid: string | null;
  originalText: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(originalText);
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus textarea when popover opens
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    } else {
      setText(originalText);
    }
  }, [open, originalText]);

  const handleConfirm = useCallback(async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(branchUuid ? { resumeAt: branchUuid } : {}),
          initialPrompt: text.trim(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }
      const { data } = (await res.json()) as { data: { id: string } };
      setOpen(false);
      router.push(`/sessions/${data.id}`);
    } catch (err) {
      console.error('[BranchPopover] fork failed:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, branchUuid, text, loading, router]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-primary/50 hover:text-primary/80 hover:bg-primary/10 rounded px-1.5 py-0.5 transition-colors"
        title="Edit message"
      >
        <Pencil className="size-3" />
        <span>Edit</span>
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Bottom sheet on mobile, floating popover on desktop */}
          <div
            className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl border-t border-white/[0.10] bg-[oklch(0.12_0_0)] shadow-2xl p-4 pb-8 space-y-3 sm:absolute sm:bottom-full sm:right-0 sm:left-auto sm:mb-2 sm:w-72 sm:rounded-xl sm:border sm:p-3 sm:pb-3 sm:space-y-2.5"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Grab handle — mobile only */}
            <div className="sm:hidden flex justify-center -mt-1 mb-1">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>
            <div className="flex items-center gap-1.5">
              <Pencil className="size-3.5 text-primary/70 shrink-0" />
              <span className="text-xs font-medium text-foreground/80">Edit message</span>
            </div>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              className="w-full rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-foreground/90 p-2 resize-none focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 placeholder:text-muted-foreground/40"
              placeholder="Edit your message…"
            />
            <div className="flex gap-2 sm:justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex-1 sm:flex-none text-xs text-muted-foreground/60 hover:text-muted-foreground px-2.5 py-2 sm:py-1 rounded hover:bg-white/[0.05] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={!text.trim() || loading}
                className="flex-1 sm:flex-none text-xs bg-primary/20 hover:bg-primary/30 text-primary border border-primary/30 px-3 py-2 sm:py-1 rounded-lg transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5"
              >
                {loading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Pencil className="size-3" />
                )}
                Edit →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UserBubble({
  text,
  attachments,
  hasImage,
  ts,
  sessionId,
  branchUuid,
}: {
  text: string;
  attachments?: DisplayAttachment[];
  hasImage?: boolean;
  ts?: number;
  sessionId?: string;
  branchUuid?: string | null;
}) {
  const hasAttachments = (attachments?.length ?? 0) > 0;
  const nativePreviewAttachments =
    attachments?.filter((attachment) => attachment.previewDataUrl) ?? [];
  const fileOnlyAttachments = attachments?.filter((attachment) => !attachment.previewDataUrl) ?? [];

  return (
    <div className="flex gap-2.5 items-start justify-end animate-fade-in-up group/userrow">
      <div className="flex flex-col items-end gap-1 min-w-0">
        <div
          dir="auto"
          className="group/userbubble relative rounded-2xl rounded-tr-sm ml-auto px-3.5 py-2.5 text-sm max-w-[85%] space-y-2 shadow-sm"
          style={{
            background:
              'linear-gradient(135deg, oklch(0.7 0.18 280 / 0.18) 0%, oklch(0.65 0.2 260 / 0.12) 100%)',
            border: '1px solid oklch(0.7 0.18 280 / 0.25)',
            boxShadow: '0 2px 12px oklch(0.7 0.18 280 / 0.08)',
          }}
        >
          {hasAttachments ? (
            <div className="space-y-2">
              {nativePreviewAttachments.length > 0 && (
                <div
                  className={`grid gap-2 ${
                    nativePreviewAttachments.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
                  }`}
                >
                  {nativePreviewAttachments.map((attachment) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={attachment.id}
                      src={attachment.previewDataUrl}
                      alt={attachment.name}
                      className="max-h-48 w-full rounded-lg object-contain"
                    />
                  ))}
                </div>
              )}
              {fileOnlyAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {fileOnlyAttachments.map((attachment) => (
                    <span
                      key={attachment.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-foreground/75"
                    >
                      <Paperclip className="size-3 shrink-0" />
                      <span className="max-w-48 truncate">{attachment.name}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : hasImage ? (
            <div className="flex items-center gap-1.5 text-xs text-primary/70">
              <Paperclip className="size-3 shrink-0" />
              <span>Image attached</span>
            </div>
          ) : null}
          {text && hasTaskNotifications(text) ? (
            <div className="space-y-1.5 w-full">
              {parseTaskNotifications(text).map((seg, si) =>
                seg.kind === 'notification' ? (
                  <TaskNotificationCard key={si} notification={seg.notification} />
                ) : (
                  <span
                    key={si}
                    className="whitespace-pre-wrap break-words block text-foreground/90 pr-5"
                  >
                    {seg.content}
                  </span>
                ),
              )}
            </div>
          ) : text ? (
            <span className="whitespace-pre-wrap break-words block text-foreground/90 pr-5">
              {text}
            </span>
          ) : null}
          {text && (
            <CopyButton
              text={text}
              className="absolute bottom-1.5 right-1 opacity-0 group-hover/userbubble:opacity-100 transition-opacity"
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          {sessionId && branchUuid !== undefined && (
            <div className="opacity-0 group-hover/userrow:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
              <BranchPopover sessionId={sessionId} branchUuid={branchUuid} originalText={text} />
            </div>
          )}
          {ts && (
            <span className="text-[10px] text-muted-foreground/25 opacity-0 group-hover/userrow:opacity-100 transition-opacity pr-0.5">
              {formatMessageTime(ts)}
            </span>
          )}
        </div>
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
  /** Events from the parent session to display before the fork point. */
  parentStream?: UseSessionStreamReturn;
  /** Assistant message UUID where the fork branches off — truncates parent display items. */
  forkPointUuid?: string;
  currentStatus: SessionStatus | null | string;
  initialPrompt?: string | null;
  agentBinaryPath?: string;
  /** Agent slug (e.g. 'codex-cli-1') — enables Codex-specific controls. */
  agentSlug?: string;
  /** When true, renders a compact version for workspace panels (smaller text, less padding) */
  compact?: boolean;
  /** When true (compact mode only), panel grows with content instead of fixed height */
  autoGrow?: boolean;
  /** When true, team messages are shown as compact inline notifications (full cards shown in TeamPanel) */
  teamPanelOpen?: boolean;
  /** Callback to open the team panel (triggered when user clicks a compact team notification) */
  onOpenTeamPanel?: () => void;
}

// Statuses where the session is ready to accept a new user message
const INPUT_READY = new Set(['awaiting_input', 'idle']);

export function SessionChatView({
  sessionId,
  stream,
  parentStream,
  forkPointUuid,
  currentStatus,
  initialPrompt,
  agentBinaryPath,
  agentSlug,
  compact = false,
  autoGrow = false,
  teamPanelOpen: _teamPanelOpen = false,
  onOpenTeamPanel: _onOpenTeamPanel,
}: SessionChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<
    { id: string; text: string; attachments?: QueuedAttachmentPayload[]; clientId?: string }[]
  >([]);
  const [resolvedApprovals, setResolvedApprovals] = useState<Set<string>>(new Set());
  const [isInterrupting, setIsInterrupting] = useState(false);
  // Tracks the effective initial prompt, which may be set optimistically on first send
  // before the server prop updates (which requires a page refresh).
  const [effectiveInitialPrompt, setEffectiveInitialPrompt] = useState<string | null>(
    initialPrompt ?? null,
  );
  const msgIdRef = useRef(0);
  const currentUserMsgCountRef = useRef(0); // always-current count from stream
  const baseUserMsgCountRef = useRef(0); // count at time of last send
  // Accumulates local attachment previews in send order so we can re-hydrate
  // user:message display items after the SSE event arrives.
  const attachmentPreviewQueueRef = useRef<QueuedAttachmentPayload[][]>([]);

  // Queued message: shown as a pill while the POST with priority:'next' is in flight.
  // Persisted to sessionStorage so it survives page refresh.
  const QUEUE_KEY = `queued-msg:${sessionId}`;
  type QueuedMessage = {
    text: string;
    attachments?: QueuedAttachmentPayload[];
    /** True while the POST is in flight */
    isSending?: boolean;
    /** Client-generated UUID nonce for dedup — pill clears when SSE with matching clientId arrives */
    clientId?: string;
  };

  function persistQueue(msg: QueuedMessage | null) {
    if (msg) sessionStorage.setItem(QUEUE_KEY, JSON.stringify(msg));
    else sessionStorage.removeItem(QUEUE_KEY);
  }

  const [queuedMessage, setQueuedMessage] = useState<QueuedMessage | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = sessionStorage.getItem(`queued-msg:${sessionId}`);
      return saved ? (JSON.parse(saved) as QueuedMessage) : null;
    } catch {
      return null;
    }
  });
  // AbortController for in-flight queued message POST
  const queueAbortRef = useRef<AbortController | null>(null);
  // restoreKey increments on every edit-queued action to ensure the useEffect
  // in SessionMessageInput re-fires even if the text is the same.
  const restoreKeyRef = useRef(0);
  const [restoredDraft, setRestoredDraft] = useState<{ text: string; key: number } | null>(null);
  const [restoredAttachments, setRestoredAttachments] = useState<PendingAttachment[] | null>(null);

  const handleInterrupt = useCallback(async () => {
    if (isInterrupting) return;
    setIsInterrupting(true);
    try {
      await fetch(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' });
    } finally {
      setIsInterrupting(false);
    }
  }, [sessionId, isInterrupting]);

  const isCodex = agentSlug === 'codex-cli-1';
  const [steerText, setSteerText] = useState('');
  const [isSteering, setIsSteering] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const handleSteer = useCallback(async () => {
    const msg = steerText.trim();
    if (!msg || isSteering) return;
    setIsSteering(true);
    try {
      await fetch(`/api/sessions/${sessionId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'steer', message: msg }),
      });
      setSteerText('');
    } finally {
      setIsSteering(false);
    }
  }, [sessionId, steerText, isSteering]);

  const handleRollback = useCallback(async () => {
    if (isRollingBack) return;
    setIsRollingBack(true);
    try {
      await fetch(`/api/sessions/${sessionId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'rollback', numTurns: 1 }),
      });
    } finally {
      setIsRollingBack(false);
    }
  }, [sessionId, isRollingBack]);

  const handleSent = useCallback(
    (text: string, attachments?: QueuedAttachmentPayload[], clientId?: string) => {
      if (attachments?.length) attachmentPreviewQueueRef.current.push(attachments);
      baseUserMsgCountRef.current = currentUserMsgCountRef.current; // capture baseline

      // When this is the very first message to a fresh session (idle, no initial prompt set),
      // the server stores it as initialPrompt and spawns — no user:message event is emitted.
      // Show it as the initial prompt banner immediately rather than an optimistic bubble
      // so the UI is consistent with what appears after a page refresh.
      if (!effectiveInitialPrompt && currentStatus === 'idle') {
        setEffectiveInitialPrompt(text);
        return;
      }

      setOptimisticMessages((prev) => [
        ...prev,
        { id: String(++msgIdRef.current), text, attachments, clientId },
      ]);
    },
    [effectiveInitialPrompt, currentStatus],
  );

  // Queue a message and POST immediately with priority:'next'.
  // Shows pill in "sending" state; on success clears pill and shows optimistic bubble.
  // On failure reverts pill to editable state. Edit/cancel abort the in-flight request.
  const handleQueue = useCallback(
    async (text: string, attachments?: QueuedAttachmentPayload[]) => {
      // Abort any previous in-flight queued POST
      queueAbortRef.current?.abort();

      const controller = new AbortController();
      queueAbortRef.current = controller;

      // Generate a client nonce so we can match the SSE user:message event later.
      // The pill stays visible until the SSE event with this clientId arrives.
      const clientId = generateId();

      // Show pill in sending state immediately
      setQueuedMessage({ text, attachments, isSending: true, clientId });

      try {
        await apiFetch(`/api/sessions/${sessionId}/message`, {
          method: 'POST',
          body: buildMessageFormData(text, attachments, { priority: 'next', clientId }),
          signal: controller.signal,
        });

        // Success — do NOT call handleSent() or clear the pill here.
        // The SSE user:message event with matching clientId will clear the pill
        // (see the clientId dedup effect below). This avoids the race condition
        // where handleSent() captures baseline AFTER the SSE already arrived.
        queueAbortRef.current = null;
        if (attachments?.length) attachmentPreviewQueueRef.current.push(attachments);
        setQueuedMessage((prev) => (prev ? { ...prev, isSending: false } : null));
      } catch (err: unknown) {
        // If aborted (edit/cancel), don't touch state — the abort handler already did
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // POST failed — revert pill to editable state (not sending)
        queueAbortRef.current = null;
        setQueuedMessage({ text, attachments, isSending: false, clientId });
      }
    },
    [sessionId],
  );

  // Send a message immediately with priority:'now' to interrupt an active agent.
  const handleSendNow = useCallback(
    async (text: string, attachments?: QueuedAttachmentPayload[]) => {
      const clientId = generateId();
      try {
        await apiFetch(`/api/sessions/${sessionId}/message`, {
          method: 'POST',
          body: buildMessageFormData(text, attachments, { priority: 'now', clientId }),
        });
        handleSent(text, attachments, clientId);
      } catch {
        // Silently ignore — the agent is still running and will continue
      }
    },
    [sessionId, handleSent],
  );

  // Edit: abort in-flight POST (if any), cancel from worker queue if already delivered,
  // and move queued message back to the textarea
  const handleEditQueued = useCallback(() => {
    if (!queuedMessage) return;
    queueAbortRef.current?.abort();
    queueAbortRef.current = null;
    // If POST already succeeded (not sending), try to cancel from worker queue
    if (!queuedMessage.isSending && queuedMessage.clientId) {
      void apiFetch(`/api/sessions/${sessionId}/control`, {
        method: 'POST',
        body: JSON.stringify({ type: 'cancel-queued', clientId: queuedMessage.clientId }),
      }).catch(() => {});
    }
    setRestoredDraft({ text: queuedMessage.text, key: ++restoreKeyRef.current });
    setRestoredAttachments(
      queuedMessage.attachments?.map((attachment) => ({
        id: generateId(),
        ...attachment,
      })) ?? null,
    );
    setQueuedMessage(null);
  }, [queuedMessage, sessionId]);

  // Cancel: abort in-flight POST (if any), cancel from worker queue if already delivered,
  // and discard the queued message
  const handleCancelQueued = useCallback(() => {
    queueAbortRef.current?.abort();
    queueAbortRef.current = null;
    // If POST already succeeded (not sending), try to cancel from worker queue
    if (queuedMessage && !queuedMessage.isSending && queuedMessage.clientId) {
      void apiFetch(`/api/sessions/${sessionId}/control`, {
        method: 'POST',
        body: JSON.stringify({ type: 'cancel-queued', clientId: queuedMessage.clientId }),
      }).catch(() => {});
    }
    setQueuedMessage(null);
  }, [queuedMessage, sessionId]);

  // Send Now from pill: abort in-flight queue POST and re-send with priority:'now'
  const handleSendNowFromPill = useCallback(() => {
    if (!queuedMessage) return;
    queueAbortRef.current?.abort();
    queueAbortRef.current = null;
    const { text, attachments } = queuedMessage;
    setQueuedMessage(null);
    void handleSendNow(text, attachments);
  }, [queuedMessage, handleSendNow]);

  // Sync queuedMessage to sessionStorage so it survives page refresh
  useEffect(() => {
    persistQueue(queuedMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedMessage]);

  // Recovery: if there's a queued message from sessionStorage (page refresh) and
  // the agent is ready for input, POST it now.
  useEffect(() => {
    if (
      !queuedMessage ||
      queuedMessage.isSending ||
      !currentStatus ||
      !INPUT_READY.has(currentStatus)
    )
      return;

    // Re-send the recovered queued message through handleQueue (which POSTs with priority)
    const msg = queuedMessage;
    setQueuedMessage(null);
    void handleQueue(msg.text, msg.attachments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStatus]);

  const handleApprovalResolved = useCallback((approvalId: string) => {
    setResolvedApprovals((prev) => new Set(prev).add(approvalId));
  }, []);

  // Shared derived arrays — avoids repeated O(n) scans of stream.events in effects below.
  const streamUserMessages = useMemo(
    () => stream.events.filter((e) => e.type === 'user:message'),
    [stream.events],
  );
  const streamCancelledMessages = useMemo(
    () => stream.events.filter((e) => e.type === 'user:message-cancelled'),
    [stream.events],
  );

  // Keep currentUserMsgCountRef in sync with the stream
  useEffect(() => {
    currentUserMsgCountRef.current = streamUserMessages.length;
  }, [streamUserMessages]);

  // Clear queued message pill once the real SSE user:message with matching clientId arrives,
  // OR when a user:message-cancelled event confirms the cancel was successful.
  // This is the primary dedup mechanism for the queue path — the pill stays visible until
  // the SSE event confirms the message was processed by the worker.
  useEffect(() => {
    if (!queuedMessage?.clientId) return;
    const clientId = queuedMessage.clientId;
    const delivered = streamUserMessages.findLast(
      (e) => 'clientId' in e && e.clientId === clientId,
    );
    const cancelled = streamCancelledMessages.findLast(
      (e) => 'clientId' in e && e.clientId === clientId,
    );
    if (delivered ?? cancelled) {
      setQueuedMessage(null);
    }
  }, [streamUserMessages, streamCancelledMessages, queuedMessage]);

  // Clear optimistic messages once the real user:message SSE event arrives.
  // Matches by clientId when available (reliable), falls back to text matching.
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    const userMessages = streamUserMessages;
    // Only consider messages beyond the baseline count
    const newMessages = userMessages.slice(baseUserMsgCountRef.current);
    if (newMessages.length === 0) return;

    // Remove optimistic messages matched by clientId or text
    const remaining = optimisticMessages.filter((m) => {
      // Prefer clientId matching (reliable, no false positives)
      if (m.clientId) {
        return !newMessages.some((e) => 'clientId' in e && e.clientId === m.clientId);
      }
      // Fallback to text matching for messages without clientId
      return !newMessages.some((e) => 'text' in e && e.text === m.text);
    });
    if (remaining.length < optimisticMessages.length) {
      setOptimisticMessages(remaining);
      // Advance baseline so we don't re-check the same events
      baseUserMsgCountRef.current = userMessages.length;
    }
  }, [streamUserMessages, optimisticMessages]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distFromBottom < 80;
    isNearBottomRef.current = near;
    setUserScrolledUp(!near);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) {
      // Use direct container scroll to avoid propagating to page-level scrollers
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    setUserScrolledUp(false);
    isNearBottomRef.current = true;
  }, []);

  // Window scroll tracking for compact+autoGrow mode only
  useEffect(() => {
    if (!compact || !autoGrow) return;
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
    if (!isNearBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (el) {
      // Scroll within the container to avoid propagating to page-level scrollers
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [stream.events.length, optimisticMessages.length]);

  const parentToolResultMap = useMemo(
    () => (parentStream ? buildToolResultMap(parentStream.events) : new Map()),
    [parentStream],
  );
  const parentDisplayItems = useMemo(() => {
    if (!parentStream) return [];
    const allItems = buildDisplayItems(parentStream.events, parentToolResultMap);
    if (!forkPointUuid) return allItems;
    // Truncate after the user message whose branchUuid matches the fork point.
    // That user message is the one that was edited to create the fork.
    const cutIdx = allItems.findIndex(
      (item) => item.kind === 'user' && item.branchUuid === forkPointUuid,
    );
    return cutIdx >= 0 ? allItems.slice(0, cutIdx) : allItems;
  }, [parentStream, parentToolResultMap, forkPointUuid]);

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

  // Rich command metadata from session:commands event (emitted by SDK adapter after init)
  const richSlashCommands = stream.events
    .filter(
      (e): e is Extract<typeof e, { type: 'session:commands' }> => e.type === 'session:commands',
    )
    .at(-1)?.slashCommands;

  // Latest prompt suggestion from session:suggestion event (Claude SDK promptSuggestions feature).
  // Only available for Claude sessions — other providers don't emit this event.
  const isClaudeSession = agentBinaryPath ? deriveProvider(agentBinaryPath) === 'claude' : false;
  const promptSuggestion = isClaudeSession
    ? stream.events
        .filter(
          (e): e is Extract<typeof e, { type: 'session:suggestion' }> =>
            e.type === 'session:suggestion',
        )
        .at(-1)?.suggestion
    : undefined;

  const isActive = currentStatus === 'active';

  // Drive typing indicator from session status OR from agent:activity thinking events.
  // findLast is available in Node 18+ / modern browsers; fall back to reverse iteration.
  const showTyping = isActive && stream.isConnected;

  // Re-hydrate user items with local attachment previews by correlating them in send order.
  const augmentedDisplayItems = (() => {
    let queueIdx = 0;
    return displayItems.map((item) => {
      if (item.kind !== 'user') {
        return item;
      }

      const previewBundle = attachmentPreviewQueueRef.current[queueIdx];
      if (!previewBundle?.length) return item;

      if (item.attachments?.length) {
        queueIdx++;
        return {
          ...item,
          attachments: item.attachments.map((attachment, index) => ({
            ...attachment,
            previewDataUrl: previewBundle[index]?.previewDataUrl,
          })),
        };
      }

      if (item.hasImage) {
        queueIdx++;
        return {
          ...item,
          attachments: previewBundle.map((attachment, index) => ({
            id: `preview-${item.id}-${index}`,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            kind: attachment.kind,
            previewDataUrl: attachment.previewDataUrl,
          })),
        };
      }

      return item;
    });
  })();

  function renderDisplayItem(
    item: DisplayItem,
    _idx: number,
    prevItem?: DisplayItem,
  ): React.ReactNode {
    // Use kind+id as key for all items — avoids collisions between numeric idx
    // and numeric item.id (e.g. both equalling 56 caused duplicate key warnings).
    const k = `${item.kind}-${item.id}`;
    switch (item.kind) {
      case 'assistant': {
        const showAvatar = prevItem?.kind !== 'assistant' && prevItem?.kind !== 'thinking';
        return (
          <AssistantBubble
            key={k}
            parts={item.parts}
            sessionId={sessionId}
            showAvatar={showAvatar}
            ts={item.ts}
            turnMeta={item.turnMeta}
          />
        );
      }
      case 'thinking':
        return <ThinkingBubble key={k} text={item.text} />;
      case 'user':
        return (
          <UserBubble
            key={k}
            text={item.text}
            attachments={item.attachments}
            hasImage={item.hasImage}
            ts={item.ts}
            sessionId={sessionId}
            branchUuid={item.branchUuid}
          />
        );
      case 'turn-complete':
        return (
          <TurnCompletePill
            key={k}
            text={item.text}
            costUsd={item.costUsd}
            sessionCostUsd={item.sessionCostUsd}
            isError={item.isError}
          />
        );
      case 'info':
        return <InfoPill key={k} text={item.text} />;
      case 'compact-loading':
        return <CompactLoadingPill key={k} trigger={item.trigger} />;
      case 'error':
        return <ErrorPill key={k} text={item.text} />;
      case 'tool-approval': {
        if (resolvedApprovals.has(item.approvalId)) return null;
        return (
          <ToolApprovalCard
            key={k}
            sessionId={sessionId}
            sessionStatus={currentStatus}
            approvalId={item.approvalId}
            toolName={item.toolName}
            toolInput={item.toolInput}
            dangerLevel={item.dangerLevel}
            onResolved={() => handleApprovalResolved(item.approvalId)}
            agentSlug={agentSlug}
          />
        );
      }
      case 'team-message': {
        // Team messages are displayed exclusively in the Team Panel.
        // This case is kept for type exhaustiveness but buildDisplayItems
        // no longer emits team-message items.
        return null;
      }
    }
  }

  return (
    <AgentSlugContext.Provider value={agentSlug}>
      <div
        className={
          fullscreen
            ? 'fixed inset-0 z-50 flex flex-col bg-[oklch(0.06_0_0)]'
            : compact && !autoGrow
              ? 'flex flex-col flex-1 min-h-0'
              : 'flex flex-col flex-1 min-h-0 rounded-xl border border-white/[0.07]'
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
          ref={!(compact && autoGrow) ? scrollContainerRef : undefined}
          onScroll={!(compact && autoGrow) ? handleScroll : undefined}
          style={compact && !autoGrow ? { touchAction: 'pan-y' } : undefined}
          className={
            fullscreen
              ? 'flex-1 overflow-y-auto overflow-x-hidden bg-[oklch(0.07_0_0)] p-3 sm:p-4 space-y-3'
              : compact && !autoGrow
                ? 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain bg-[oklch(0.07_0_0)] p-2 space-y-2'
                : compact && autoGrow
                  ? 'overflow-x-hidden bg-[oklch(0.07_0_0)] p-2 space-y-2'
                  : 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-[oklch(0.07_0_0)] p-3 sm:p-4 space-y-3'
          }
          role="log"
          aria-live="polite"
          aria-label="Session chat"
        >
          {stream.events.length === 0 && parentDisplayItems.length === 0 && !stream.error && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground/60">
              {currentStatus === 'idle' && !effectiveInitialPrompt ? (
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

          {/* Parent session history for forked sessions */}
          {parentDisplayItems.length > 0 ? (
            <>
              {parentDisplayItems.map((item, i) =>
                renderDisplayItem(item, i, parentDisplayItems[i - 1]),
              )}
              <div className="flex items-center gap-3 py-3 px-1">
                <div className="flex-1 border-t border-dashed border-muted-foreground/20" />
                <span className="text-[11px] text-muted-foreground/40 flex items-center gap-1.5">
                  <svg
                    className="size-3"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M5 3v4m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6-4v2m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 4v4M5 7h6" />
                  </svg>
                  Forked here
                </span>
                <div className="flex-1 border-t border-dashed border-muted-foreground/20" />
              </div>
              {/* Fork's initial prompt appears after the separator, not at the top */}
              {effectiveInitialPrompt && <InitialPromptBanner prompt={effectiveInitialPrompt} />}
            </>
          ) : (
            /* Non-fork: initial prompt banner at the top as usual */
            effectiveInitialPrompt && <InitialPromptBanner prompt={effectiveInitialPrompt} />
          )}

          {augmentedDisplayItems.map((item, i) =>
            renderDisplayItem(item, i, augmentedDisplayItems[i - 1]),
          )}

          {/* Optimistic user messages shown while real event is in-flight */}
          {optimisticMessages.map((msg) => (
            <UserBubble
              key={`opt-${msg.id}`}
              text={msg.text}
              attachments={msg.attachments?.map((attachment, index) => ({
                ...attachment,
                id: `opt-${msg.id}-${index}`,
              }))}
            />
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
                : 'shrink-0 rounded-b-xl bg-[oklch(0.085_0_0)]/95 backdrop-blur-sm border-t border-white/[0.05]'
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
            {/* Codex steer input — inject guidance mid-turn */}
            {isActive && isCodex && (
              <div className="flex items-center gap-1.5 px-3 pt-1.5">
                <input
                  type="text"
                  value={steerText}
                  onChange={(e) => setSteerText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSteer();
                    }
                  }}
                  placeholder="Steer (inject guidance mid-turn)…"
                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-white/[0.15]"
                />
                <button
                  type="button"
                  onClick={() => void handleSteer()}
                  disabled={!steerText.trim() || isSteering}
                  className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary bg-primary/10 hover:bg-primary/20 border border-primary/20 rounded px-2 py-1 transition-colors disabled:opacity-40"
                >
                  {isSteering ? <Loader2 className="size-3 animate-spin" /> : null}
                  Steer
                </button>
              </div>
            )}
            {/* Codex rollback button — undo last turn (conversation only) */}
            {currentStatus === 'awaiting_input' && isCodex && (
              <div className="flex justify-end px-3 pt-1">
                <button
                  type="button"
                  onClick={() => void handleRollback()}
                  disabled={isRollingBack}
                  title="Undo last turn. File changes are NOT reverted — use git diff / git checkout to revert files manually."
                  className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 hover:bg-white/[0.04] rounded px-2 py-0.5 transition-colors disabled:opacity-40"
                >
                  {isRollingBack ? <Loader2 className="size-3 animate-spin" /> : <span>↩</span>}
                  Undo last turn
                </button>
              </div>
            )}
            {/* Pending queued message pill — shown when user sent a message while agent was active */}
            {queuedMessage && (
              <div className="px-3 pt-2">
                <PendingMessagePill
                  text={queuedMessage.text}
                  attachments={queuedMessage.attachments}
                  isSending={queuedMessage.isSending}
                  onEdit={handleEditQueued}
                  onCancel={handleCancelQueued}
                  onSendNow={handleSendNowFromPill}
                />
              </div>
            )}
            <SessionMessageInput
              sessionId={sessionId}
              status={currentStatus as SessionStatus}
              onSent={handleSent}
              onQueue={handleQueue}
              onSendNow={handleSendNow}
              restoredDraft={restoredDraft}
              restoredAttachments={restoredAttachments}
              slashCommands={slashCommands}
              richSlashCommands={richSlashCommands}
              mcpServers={mcpServers}
              agentBinaryPath={agentBinaryPath}
              neverStarted={currentStatus === 'idle' && stream.events.length === 0}
              promptSuggestion={promptSuggestion}
            />
          </div>
        )}
      </div>
    </AgentSlugContext.Provider>
  );
}
