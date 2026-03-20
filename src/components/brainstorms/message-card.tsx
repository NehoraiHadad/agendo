'use client';

import { memo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronUp, ChevronsRight, Copy, Check } from 'lucide-react';
import { getAgentColor } from '@/lib/utils/brainstorm-colors';
import { Badge } from '@/components/ui/badge';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import type { BrainstormMessageItem, ReviewState } from '@/stores/brainstorm-store';
import { brainstormMdComponents } from './markdown-components';

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
      <AgentAvatar
        name={agentName}
        slug={agentSlug}
        index={agentIndex}
        size="xs"
        className="opacity-20"
      />
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
  role,
}: {
  agentName: string;
  agentSlug: string;
  agentIndex: number;
  text: string;
  wave: number;
  role?: string | null;
}) {
  const colors = getAgentColor(agentSlug, agentIndex);

  return (
    <div
      className={`flex gap-3 items-start ${colors.bg} rounded-xl p-3 border-l-2 ${colors.border}`}
    >
      {/* Avatar */}
      <AgentAvatar
        name={agentName}
        slug={agentSlug}
        index={agentIndex}
        pulse
        className="bg-opacity-20 border-opacity-40"
      />

      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-medium text-foreground/80">{agentName}</span>
          {role && (
            <Badge
              variant="outline"
              className="text-[9px] h-[14px] px-1 py-0 font-medium capitalize bg-white/[0.02] border-white/[0.08]"
            >
              {role}
            </Badge>
          )}
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
          <div
            dir="auto"
            className="text-xs text-foreground/65 break-words overflow-hidden leading-relaxed"
          >
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
  activity,
  role,
}: {
  agentName: string;
  agentSlug: string;
  agentIndex: number;
  wave: number;
  /** Optional description of what the agent is currently doing */
  activity?: string | null;
  role?: string | null;
}) {
  const colors = getAgentColor(agentSlug, agentIndex);

  return (
    <div
      className={`flex gap-3 items-center ${colors.bg} rounded-xl px-3 py-2.5 border-l-2 ${colors.border} opacity-50`}
      role="status"
      aria-label={`${agentName} is ${activity ?? 'thinking'}`}
    >
      {/* Avatar — pulsing to signal activity */}
      <AgentAvatar name={agentName} slug={agentSlug} index={agentIndex} className="animate-pulse" />

      <div className="flex flex-1 min-w-0 items-center gap-2">
        <span className="text-xs font-medium text-foreground/60 truncate">{agentName}</span>
        {role && (
          <Badge
            variant="outline"
            className="text-[9px] h-[14px] px-1 py-0 font-medium capitalize bg-white/[0.02] border-white/[0.08]"
          >
            {role}
          </Badge>
        )}
        {activity ? (
          <span className="text-[10px] text-muted-foreground/35 truncate max-w-[200px]">
            {activity}
          </span>
        ) : null}
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
          <p
            dir="auto"
            className="text-xs text-foreground/85 leading-relaxed whitespace-pre-wrap break-words"
          >
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
// Feedback Buttons
// ============================================================================

type FeedbackSignal = 'thumbs_up' | 'thumbs_down' | 'focus';

interface FeedbackButtonsProps {
  roomId: string;
  wave: number;
  agentId: string;
}

function FeedbackButtons({ roomId, wave, agentId }: FeedbackButtonsProps) {
  const [submitted, setSubmitted] = useState<FeedbackSignal | null>(null);
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async (signal: FeedbackSignal) => {
      if (submitted || pending) return;
      setPending(true);
      try {
        await fetch(`/api/brainstorms/${roomId}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wave, agentId, signal }),
        });
        setSubmitted(signal);
      } finally {
        setPending(false);
      }
    },
    [roomId, wave, agentId, submitted, pending],
  );

  const buttons: Array<{ signal: FeedbackSignal; emoji: string; label: string }> = [
    { signal: 'thumbs_up', emoji: '👍', label: 'On track' },
    { signal: 'thumbs_down', emoji: '👎', label: 'Off topic' },
    { signal: 'focus', emoji: '🎯', label: 'Dig deeper' },
  ];

  return (
    <div className="flex items-center gap-1 mt-1.5" role="group" aria-label="Wave feedback">
      {buttons.map(({ signal, emoji, label }) => (
        <button
          key={signal}
          type="button"
          onClick={() => void submit(signal)}
          disabled={submitted !== null || pending}
          aria-pressed={submitted === signal}
          aria-label={label}
          title={label}
          className={`text-sm px-1.5 py-0.5 rounded transition-opacity
            ${submitted === signal ? 'opacity-100' : 'opacity-30 hover:opacity-70'}
            ${submitted !== null && submitted !== signal ? 'opacity-10' : ''}
            disabled:cursor-not-allowed`}
        >
          {emoji}
        </button>
      ))}
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
  /** Active review window — when set, shows feedback buttons */
  reviewState?: ReviewState | null;
  roomId?: string;
  role?: string | null;
}

const COLLAPSE_LINE_COUNT = 20;

function AgentMessageCard({
  message,
  agentSlug,
  agentIndex,
  reviewState,
  roomId,
  role,
}: AgentMessageProps) {
  const colors = getAgentColor(agentSlug, agentIndex);
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const time = new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const agentName = message.agentName ?? 'Agent';

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  const lines = message.content.split('\n');
  const shouldCollapse = lines.length > COLLAPSE_LINE_COUNT;
  const displayContent =
    shouldCollapse && !expanded
      ? lines.slice(0, COLLAPSE_LINE_COUNT).join('\n') + '\n…'
      : message.content;

  return (
    <div className={`flex gap-3 items-start group`}>
      {/* Agent avatar */}
      <AgentAvatar name={agentName} slug={agentSlug} index={agentIndex} className="mt-0.5" />

      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-medium text-foreground/80">{agentName}</span>
          {role && (
            <Badge
              variant="outline"
              className="text-[9px] h-[14px] px-1 py-0 font-medium capitalize bg-white/[0.02] border-white/[0.08]"
            >
              {role}
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground/30 bg-white/[0.04] rounded px-1.5 py-0.5 border border-white/[0.06]">
            Wave {message.wave}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground/25 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
            {time}
          </span>
        </div>

        {/* Message bubble */}
        <div
          className={`${colors.bg} rounded-xl rounded-tl-sm border-l-2 ${colors.border} px-3 py-2.5 relative`}
        >
          {/* Copy button — top right, hover revealed */}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="absolute top-2 right-2 p-1 rounded hover:bg-white/[0.08] opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Copy message"
          >
            {copied ? (
              <Check className="size-3 text-emerald-400" />
            ) : (
              <Copy className="size-3 text-muted-foreground/40" />
            )}
          </button>

          <div
            dir="auto"
            className="text-xs text-foreground/75 break-words overflow-hidden leading-relaxed"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={brainstormMdComponents}>
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

          {/* Feedback buttons — only shown during an active review window */}
          {reviewState && reviewState.wave === message.wave && message.agentId && roomId && (
            <FeedbackButtons roomId={roomId} wave={message.wave} agentId={message.agentId} />
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
  /** Active review window state — when set, shows feedback buttons on agent messages */
  reviewState?: ReviewState | null;
  /** Brainstorm room ID — required for posting feedback */
  roomId?: string;
  role?: string | null;
}

export const MessageCard = memo(function MessageCard({
  message,
  agentSlug = '',
  agentIndex = 0,
  reviewState,
  roomId,
  role,
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

  return (
    <AgentMessageCard
      message={message}
      agentSlug={agentSlug}
      agentIndex={agentIndex}
      reviewState={reviewState}
      roomId={roomId}
      role={role}
    />
  );
});
