'use client';

import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronUp, ChevronsRight } from 'lucide-react';
import { getAgentColor, getInitials } from '@/lib/utils/brainstorm-colors';
import type { BrainstormMessageItem } from '@/stores/brainstorm-store';

// ============================================================================
// Markdown components (shared)
// ============================================================================

const mdComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-');
    return isBlock ? (
      <code className="block bg-black/20 rounded-md px-3 py-2 text-[11px] font-mono overflow-x-auto whitespace-pre my-2 border border-white/[0.06]">
        {children}
      </code>
    ) : (
      <code className="bg-black/20 rounded px-1 py-px text-[11px] font-mono border border-white/[0.06]">
        {children}
      </code>
    );
  },
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-4 mb-1.5 space-y-0.5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-foreground/70 leading-relaxed">{children}</li>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-sm font-semibold text-foreground/90 mb-1 mt-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-xs font-semibold text-foreground/80 mb-1 mt-2.5 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-xs font-medium text-foreground/75 mb-1 mt-2 first:mt-0">{children}</h3>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-white/20 pl-3 text-foreground/55 italic my-1.5">
      {children}
    </blockquote>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground/85">{children}</strong>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary/70 underline underline-offset-2 hover:text-primary/90 transition-colors"
    >
      {children}
    </a>
  ),
};

// ============================================================================
// Pass Message
// ============================================================================

interface PassMessageProps {
  agentName: string;
  agentSlug: string;
  agentIndex: number;
}

function PassMessage({ agentName, agentSlug, agentIndex }: PassMessageProps) {
  const colors = getAgentColor(agentSlug, agentIndex);
  return (
    <div
      className="flex items-center gap-2 py-0.5"
      aria-label={`${agentName} skipped this wave`}
      title={`${agentName} passed`}
    >
      <div
        className={`shrink-0 size-5 rounded-full flex items-center justify-center text-[8px] font-bold border ${colors.border.replace('border-l-', 'border-')} opacity-20`}
      >
        <span className={`${colors.dot} opacity-70`}>{getInitials(agentName)}</span>
      </div>
      <span className={`text-[10px] font-medium ${colors.dot} opacity-25`}>{agentName}</span>
      <ChevronsRight className="size-3 text-muted-foreground/20 shrink-0" />
    </div>
  );
}

// ============================================================================
// Streaming Card
// ============================================================================

export function StreamingCard({
  agentName,
  agentSlug,
  agentIndex,
  text,
  wave,
}: {
  agentName: string;
  agentSlug: string;
  agentIndex: number;
  text: string;
  wave: number;
}) {
  const colors = getAgentColor(agentSlug, agentIndex);
  const initials = getInitials(agentName);

  return (
    <div
      className={`flex gap-3 items-start ${colors.bg} rounded-xl p-3 border-l-2 ${colors.border}`}
    >
      {/* Avatar */}
      <div
        className={`shrink-0 size-7 rounded-full flex items-center justify-center text-[10px] font-bold ${colors.pulse} bg-opacity-20 border ${colors.border.replace('border-l-', 'border-')} border-opacity-40`}
        aria-hidden="true"
      >
        <span className={colors.dot}>{initials}</span>
      </div>

      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-medium text-foreground/80">{agentName}</span>
          <span className="text-[10px] text-muted-foreground/30 bg-white/[0.04] rounded px-1.5 py-0.5 border border-white/[0.06]">
            Wave {wave}
          </span>
          {/* Streaming indicator */}
          <span className="ml-auto flex items-center gap-0.5" aria-label="Agent is thinking">
            <span
              className={`size-1 rounded-full ${colors.pulse} animate-bounce`}
              style={{ animationDelay: '0ms' }}
            />
            <span
              className={`size-1 rounded-full ${colors.pulse} animate-bounce`}
              style={{ animationDelay: '150ms' }}
            />
            <span
              className={`size-1 rounded-full ${colors.pulse} animate-bounce`}
              style={{ animationDelay: '300ms' }}
            />
          </span>
        </div>

        {/* Streaming text */}
        {text && (
          <div className="text-xs text-foreground/65 break-words overflow-hidden leading-relaxed">
            {text}
            <span
              className={`inline-block w-0.5 h-3 ml-0.5 ${colors.pulse} animate-pulse align-middle`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Thinking Card (agent has been dispatched but hasn't started writing yet)
// ============================================================================

export function ThinkingCard({
  agentName,
  agentSlug,
  agentIndex,
  wave,
}: {
  agentName: string;
  agentSlug: string;
  agentIndex: number;
  wave: number;
}) {
  const colors = getAgentColor(agentSlug, agentIndex);
  const initials = getInitials(agentName);

  return (
    <div
      className={`flex gap-3 items-center ${colors.bg} rounded-xl px-3 py-2.5 border-l-2 ${colors.border} opacity-50`}
      role="status"
      aria-label={`${agentName} is thinking`}
    >
      {/* Avatar — pulsing to signal activity */}
      <div
        className={`shrink-0 size-7 rounded-full flex items-center justify-center text-[10px] font-bold animate-pulse border ${colors.border.replace('border-l-', 'border-')} bg-white/[0.03]`}
        aria-hidden="true"
      >
        <span className={colors.dot}>{initials}</span>
      </div>

      <div className="flex flex-1 min-w-0 items-center gap-2">
        <span className="text-xs font-medium text-foreground/60 truncate">{agentName}</span>
        <span className="text-[10px] text-muted-foreground/30 bg-white/[0.04] rounded px-1.5 py-0.5 border border-white/[0.06] shrink-0">
          Wave {wave}
        </span>

        {/* Bouncing dots */}
        <span className="ml-auto flex items-center gap-0.5 shrink-0" aria-hidden="true">
          <span
            className={`size-1 rounded-full ${colors.pulse} animate-bounce`}
            style={{ animationDelay: '0ms' }}
          />
          <span
            className={`size-1 rounded-full ${colors.pulse} animate-bounce`}
            style={{ animationDelay: '150ms' }}
          />
          <span
            className={`size-1 rounded-full ${colors.pulse} animate-bounce`}
            style={{ animationDelay: '300ms' }}
          />
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// User Message
// ============================================================================

function UserMessage({ content, ts }: { content: string; ts: number }) {
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex justify-end gap-2.5 items-end">
      <div className="max-w-[80%] group space-y-1">
        <div className="bg-primary/[0.10] border border-primary/20 rounded-2xl rounded-br-sm px-3.5 py-2.5">
          <p className="text-xs text-foreground/85 leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </p>
        </div>
        <div className="flex justify-end">
          <span className="text-[10px] text-muted-foreground/25 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
            {time}
          </span>
        </div>
      </div>
      <div
        className="shrink-0 size-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mb-5"
        aria-hidden="true"
      >
        <span className="text-[9px] font-bold text-primary/60">You</span>
      </div>
    </div>
  );
}

// ============================================================================
// Agent Message Card
// ============================================================================

interface AgentMessageProps {
  message: BrainstormMessageItem;
  agentSlug: string;
  agentIndex: number;
}

const COLLAPSE_LINE_COUNT = 20;

function AgentMessageCard({ message, agentSlug, agentIndex }: AgentMessageProps) {
  const colors = getAgentColor(agentSlug, agentIndex);
  const [expanded, setExpanded] = useState(true);
  const time = new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const agentName = message.agentName ?? 'Agent';
  const initials = getInitials(agentName);

  const lines = message.content.split('\n');
  const shouldCollapse = lines.length > COLLAPSE_LINE_COUNT;
  const displayContent =
    shouldCollapse && !expanded
      ? lines.slice(0, COLLAPSE_LINE_COUNT).join('\n') + '\n…'
      : message.content;

  return (
    <div className={`flex gap-3 items-start group`}>
      {/* Agent avatar */}
      <div
        className={`shrink-0 size-7 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5 border ${colors.border.replace('border-l-', 'border-')} bg-white/[0.03]`}
        aria-label={agentName}
      >
        <span className={colors.dot}>{initials}</span>
      </div>

      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-medium text-foreground/80">{agentName}</span>
          <span className="text-[10px] text-muted-foreground/30 bg-white/[0.04] rounded px-1.5 py-0.5 border border-white/[0.06]">
            Wave {message.wave}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground/25 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
            {time}
          </span>
        </div>

        {/* Message bubble */}
        <div
          className={`${colors.bg} rounded-xl rounded-tl-sm border-l-2 ${colors.border} px-3 py-2.5`}
        >
          <div className="text-xs text-foreground/75 break-words overflow-hidden leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {displayContent}
            </ReactMarkdown>
          </div>

          {/* Expand / collapse */}
          {shouldCollapse && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={`flex items-center gap-1 mt-2 text-[10px] ${colors.dot} opacity-50 hover:opacity-80 transition-opacity`}
            >
              {expanded ? (
                <>
                  <ChevronUp className="size-3" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="size-3" />
                  Show more
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main MessageCard export
// ============================================================================

export interface MessageCardProps {
  message: BrainstormMessageItem;
  /** Agent slug for color mapping */
  agentSlug?: string;
  /** Index in participant list for color rotation fallback */
  agentIndex?: number;
}

export const MessageCard = memo(function MessageCard({
  message,
  agentSlug = '',
  agentIndex = 0,
}: MessageCardProps) {
  if (message.senderType === 'user') {
    return <UserMessage content={message.content} ts={message.ts} />;
  }

  if (message.isPass) {
    return (
      <PassMessage
        agentName={message.agentName ?? 'Agent'}
        agentSlug={agentSlug}
        agentIndex={agentIndex}
      />
    );
  }

  return <AgentMessageCard message={message} agentSlug={agentSlug} agentIndex={agentIndex} />;
});
