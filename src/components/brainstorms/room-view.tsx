'use client';

import { useRef, useEffect, useState, useMemo, memo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Waves,
  Sparkles,
  Users,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCard, StreamingCard, ThinkingCard } from './message-card';
import { ComposeBar } from './compose-bar';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import type { BrainstormMessageItem, ParticipantState } from '@/stores/brainstorm-store';

// ============================================================================
// Wave divider
// ============================================================================

function WaveDivider({ wave }: { wave: number }) {
  return (
    <div className="flex items-center gap-3 py-3 px-1" role="separator" aria-label={`Wave ${wave}`}>
      <div className="flex-1 h-px bg-white/[0.05]" />
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/25 font-mono tracking-widest uppercase">
        <Waves className="size-3" />
        Wave {wave}
      </div>
      <div className="flex-1 h-px bg-white/[0.05]" />
    </div>
  );
}

// ============================================================================
// Status banners
// ============================================================================

function ConvergedBanner() {
  return (
    <div
      className="mx-4 my-3 flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-950/25 px-4 py-3"
      role="status"
    >
      <CheckCircle2 className="size-4 text-emerald-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-xs font-semibold text-emerald-300/90">Consensus reached</p>
        <p className="text-[11px] text-muted-foreground/45 mt-0.5 leading-relaxed">
          All participants have converged on a common perspective. You can synthesize or end the
          brainstorm.
        </p>
      </div>
    </div>
  );
}

function MaxWavesBanner() {
  return (
    <div
      className="mx-4 my-3 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-950/25 px-4 py-3"
      role="status"
    >
      <AlertCircle className="size-4 text-amber-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-xs font-semibold text-amber-300/90">Maximum waves reached</p>
        <p className="text-[11px] text-muted-foreground/45 mt-0.5 leading-relaxed">
          All discussion rounds have completed. Synthesize the findings or end the brainstorm.
        </p>
      </div>
    </div>
  );
}

function EndedBanner() {
  return (
    <div
      className="mx-4 my-3 flex items-center gap-3 rounded-xl border border-zinc-700/30 bg-zinc-900/30 px-4 py-3"
      role="status"
    >
      <span className="size-2 rounded-full bg-zinc-600 shrink-0" />
      <p className="text-xs text-muted-foreground/40">This brainstorm has ended</p>
    </div>
  );
}

// ============================================================================
// Synthesis panel
// ============================================================================

const synthesisMarkdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-sm font-semibold text-foreground/90 mb-2 mt-4 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-xs font-semibold text-foreground/80 mb-1.5 mt-3 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-xs font-medium text-foreground/75 mb-1 mt-2 first:mt-0">{children}</h3>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-foreground/70 leading-relaxed">{children}</li>
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
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-violet-500/30 pl-3 text-foreground/65 italic my-2">
      {children}
    </blockquote>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground/85">{children}</strong>
  ),
};

function SynthesisPanel({ synthesis }: { synthesis: string }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mx-4 my-3 rounded-xl border border-violet-500/20 bg-violet-950/15 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-violet-950/20 transition-colors"
        aria-expanded={expanded}
      >
        <Sparkles className="size-3.5 text-violet-400/70 shrink-0" />
        <span className="text-xs font-semibold text-violet-300/90 flex-1 text-left">Synthesis</span>
        {!expanded && (
          <span className="text-[10px] text-muted-foreground/35 mr-1">Click to expand</span>
        )}
        {expanded ? (
          <ChevronDown className="size-3.5 text-violet-400/50 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 text-violet-400/50 shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-4 text-xs text-foreground/70 border-t border-violet-500/10">
          <div className="pt-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={synthesisMarkdownComponents}>
              {synthesis}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Message list (grouped by wave)
// ============================================================================

interface SlugMap {
  [agentId: string]: { slug: string; index: number };
}

interface GroupedMessages {
  wave: number;
  messages: BrainstormMessageItem[];
}

function groupMessagesByWave(messages: BrainstormMessageItem[]): GroupedMessages[] {
  const groups: GroupedMessages[] = [];
  let currentWave = -1;

  for (const msg of messages) {
    if (msg.wave !== currentWave) {
      groups.push({ wave: msg.wave, messages: [msg] });
      currentWave = msg.wave;
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }
  return groups;
}

const MessageList = memo(function MessageList({
  messages,
  slugMap,
  streamingText,
  participants,
  currentWave,
}: {
  messages: BrainstormMessageItem[];
  slugMap: SlugMap;
  streamingText: Map<string, string>;
  participants: Map<string, ParticipantState>;
  currentWave: number;
}) {
  const groups = groupMessagesByWave(messages);
  const streamingEntries = Array.from(streamingText.entries());

  return (
    <>
      {groups.map((group) => (
        <div key={group.wave}>
          {group.wave > 0 && <WaveDivider wave={group.wave} />}
          <div className="px-4 space-y-3">
            {group.messages.map((msg) => {
              const agentInfo = msg.agentId ? slugMap[msg.agentId] : undefined;
              return (
                <MessageCard
                  key={`${msg.id}-${msg.ts}`}
                  message={msg}
                  agentSlug={agentInfo?.slug ?? ''}
                  agentIndex={agentInfo?.index ?? 0}
                />
              );
            })}
          </div>
        </div>
      ))}

      {/* Thinking + streaming indicators for the current wave */}
      {(() => {
        // Agents thinking (dispatched but no streaming text yet)
        const thinkingAgents = Array.from(participants.values()).filter(
          (p) => p.status === 'thinking' && !streamingText.has(p.agentId),
        );
        // Agents actively writing (have streaming text)
        const hasThinking = thinkingAgents.length > 0;
        const hasStreaming = streamingEntries.length > 0;
        if (!hasThinking && !hasStreaming) return null;
        return (
          <div className="px-4 space-y-2 mt-3">
            {thinkingAgents.map((p) => {
              const agentInfo = slugMap[p.agentId];
              return (
                <ThinkingCard
                  key={p.agentId}
                  agentName={p.agentName}
                  agentSlug={agentInfo?.slug ?? ''}
                  agentIndex={agentInfo?.index ?? 0}
                  wave={currentWave}
                />
              );
            })}
            {streamingEntries.map(([agentId, text]) => {
              const participant = participants.get(agentId);
              const agentInfo = slugMap[agentId];
              if (!participant) return null;
              return (
                <StreamingCard
                  key={agentId}
                  agentName={participant.agentName}
                  agentSlug={agentInfo?.slug ?? ''}
                  agentIndex={agentInfo?.index ?? 0}
                  text={text}
                  wave={currentWave}
                />
              );
            })}
          </div>
        );
      })()}
    </>
  );
});

// ============================================================================
// Empty state
// ============================================================================

function EmptyState({ status }: { status: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
      <div className="size-12 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
        <Waves className="size-5 text-muted-foreground/20" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground/40">No messages yet</p>
        <p className="text-xs text-muted-foreground/25 max-w-xs mx-auto leading-relaxed">
          {status === 'waiting'
            ? 'Start the brainstorm to begin the first wave of discussion.'
            : 'Waiting for the first wave to begin...'}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Main RoomView
// ============================================================================

export function RoomView({
  roomId,
  onOpenMobileSidebar,
}: {
  roomId: string;
  /** Called when the user taps the participants button on mobile. */
  onOpenMobileSidebar?: () => void;
}) {
  // Individual selectors — each returns a stable primitive or reference.
  // Zustand 5 requires `getSnapshot` to be cached; object selectors `(s) => ({...})`
  // always return new references and cause an infinite useSyncExternalStore loop.
  const messages = useBrainstormStore((s) => s.messages);
  const streamingText = useBrainstormStore((s) => s.streamingText);
  const participants = useBrainstormStore((s) => s.participants);
  const status = useBrainstormStore((s) => s.status);
  const synthesis = useBrainstormStore((s) => s.synthesis);
  const converged = useBrainstormStore((s) => s.converged);
  const maxWavesReached = useBrainstormStore((s) => s.maxWavesReached);
  const currentWave = useBrainstormStore((s) => s.currentWave);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Build slug map from participants for stable color assignment.
  // Memoized so re-renders triggered by streaming text don't rebuild it unnecessarily.
  const slugMap = useMemo(() => {
    const map: SlugMap = {};
    let index = 0;
    for (const [agentId, p] of participants) {
      map[agentId] = { slug: p.agentSlug, index: index++ };
    }
    return map;
  }, [participants]);

  // Auto-scroll to bottom when new messages arrive (only if already at bottom)
  useEffect(() => {
    if (isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, streamingText.size, isAtBottom]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const threshold = 100;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setIsAtBottom(atBottom);
  };

  const isEmpty = messages.length === 0 && streamingText.size === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 relative">
      {/* Scrollable message area */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        onScroll={handleScroll}
        ref={scrollRef}
        role="log"
        aria-label="Brainstorm messages"
        aria-live="polite"
      >
        {isEmpty ? (
          <EmptyState status={status} />
        ) : (
          <div className="py-5 space-y-0">
            <MessageList
              messages={messages}
              slugMap={slugMap}
              streamingText={streamingText}
              participants={participants}
              currentWave={currentWave}
            />
          </div>
        )}

        {/* Status banners */}
        {converged && <ConvergedBanner />}
        {maxWavesReached && !converged && <MaxWavesBanner />}
        {status === 'ended' && <EndedBanner />}

        {/* Synthesis */}
        {synthesis && <SynthesisPanel synthesis={synthesis} />}

        <div ref={bottomRef} className="h-4" />
      </div>

      {/* Floating action buttons (bottom-right) */}
      <div className="absolute bottom-20 right-4 z-10 flex flex-col gap-2 items-end">
        {/* Participants panel — mobile only */}
        {onOpenMobileSidebar && (
          <button
            type="button"
            onClick={onOpenMobileSidebar}
            className="md:hidden flex items-center justify-center size-8 rounded-full bg-zinc-900 border border-white/[0.10] text-muted-foreground/60 hover:text-foreground/80 shadow-xl transition-all hover:bg-zinc-800 hover:scale-105"
            aria-label="Open participants panel"
          >
            <Users className="size-4" />
          </button>
        )}

        {/* Scroll to bottom */}
        {!isAtBottom && (
          <button
            type="button"
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="flex items-center justify-center size-8 rounded-full bg-zinc-900 border border-white/[0.10] text-muted-foreground/60 hover:text-foreground/80 shadow-xl transition-all hover:bg-zinc-800 hover:scale-105"
            aria-label="Scroll to bottom"
          >
            <ChevronDown className="size-4" />
          </button>
        )}
      </div>

      {/* Compose bar */}
      <ComposeBar roomId={roomId} status={status} />
    </div>
  );
}
