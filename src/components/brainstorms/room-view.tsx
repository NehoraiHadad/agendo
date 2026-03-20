'use client';

import { useRef, useEffect, useState, useMemo, memo, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Waves,
  Sparkles,
  Users,
  Copy,
  Check,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCard, StreamingCard, ThinkingCard } from './message-card';
import { ComposeBar } from './compose-bar';
import { synthesisMdComponents } from './markdown-components';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import type {
  BrainstormMessageItem,
  ParticipantState,
  ReviewState,
} from '@/stores/brainstorm-store';

// ============================================================================
// Wave divider
// ============================================================================

function WaveDivider({ wave, isReflection }: { wave: number; isReflection?: boolean }) {
  // wave is 0-indexed internally; display as 1-indexed for humans
  const displayWave = wave + 1;
  return (
    <div
      className="flex items-center gap-3 py-3 px-1"
      role="separator"
      aria-label={isReflection ? `Reflection Wave ${displayWave}` : `Wave ${displayWave}`}
    >
      <div className="flex-1 h-px bg-white/[0.05]" />
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/25 font-mono tracking-widest uppercase">
        <Waves className="size-3" />
        Wave {displayWave}
        {isReflection && (
          <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-sky-500/15 text-sky-400/70 border border-sky-500/20 normal-case tracking-normal">
            Reflection
          </span>
        )}
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

function SynthesisPanel({ synthesis, taskId }: { synthesis: string; taskId: string | null }) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(synthesis);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    },
    [synthesis],
  );

  // Detect if the synthesis has the structured Decision Log format
  const hasNextSteps = /^## Next Steps/m.test(synthesis);

  return (
    <div className="mx-4 my-3 rounded-xl border border-violet-500/20 bg-violet-950/15 overflow-hidden">
      <div className="w-full flex items-center gap-2.5 px-4 py-3">
        {/* Clickable expand/collapse area */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2.5 flex-1 hover:opacity-80 transition-opacity"
          aria-expanded={expanded}
        >
          <Sparkles className="size-3.5 text-violet-400/70 shrink-0" />
          <span className="text-xs font-semibold text-violet-300/90 flex-1 text-left">
            Decision Log
          </span>
          {!expanded && (
            <span className="text-[10px] text-muted-foreground/35 mr-1">Click to expand</span>
          )}
          {expanded ? (
            <ChevronDown className="size-3.5 text-violet-400/50 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 text-violet-400/50 shrink-0" />
          )}
        </button>

        {/* Copy button — separate from expand/collapse */}
        <button
          type="button"
          onClick={(e) => void handleCopy(e)}
          className="p-1.5 rounded-md hover:bg-violet-500/10 transition-colors shrink-0"
          aria-label="Copy synthesis to clipboard"
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-400" />
          ) : (
            <Copy className="size-3.5 text-violet-400/50" />
          )}
        </button>
      </div>
      {expanded && (
        <div className="px-4 pb-4 text-xs text-foreground/70 border-t border-violet-500/10">
          <div dir="auto" className="pt-3 synthesis-decision-log">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={synthesisMdComponents}>
              {synthesis}
            </ReactMarkdown>
          </div>
          {/* Link to parent task if next steps were created */}
          {hasNextSteps && taskId && (
            <div className="mt-3 pt-3 border-t border-violet-500/10">
              <a
                href={`/tasks/${taskId}`}
                className="inline-flex items-center gap-1.5 text-[11px] text-violet-400/70 hover:text-violet-300 transition-colors"
              >
                <ExternalLink className="size-3" />
                View created tasks on board
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Message list (grouped by wave)
// ============================================================================

interface SlugMap {
  [participantId: string]: { slug: string; index: number };
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
  reflectionWaves,
  reviewState,
  roomId,
}: {
  messages: BrainstormMessageItem[];
  slugMap: SlugMap;
  streamingText: Map<string, string>;
  participants: Map<string, ParticipantState>;
  currentWave: number;
  reflectionWaves: Set<number>;
  reviewState: ReviewState | null;
  roomId: string;
}) {
  const groups = groupMessagesByWave(messages);
  const streamingEntries = Array.from(streamingText.entries());

  return (
    <>
      {groups.map((group, idx) => (
        <div key={`wave-${group.wave}-${idx}`}>
          {group.wave > 0 && (
            <WaveDivider wave={group.wave} isReflection={reflectionWaves.has(group.wave)} />
          )}
          <div className="px-4 space-y-3">
            {group.messages.map((msg) => {
              const participant =
                (msg.participantId ? participants.get(msg.participantId) : undefined) ??
                (msg.agentId
                  ? Array.from(participants.values()).find((entry) => entry.agentId === msg.agentId)
                  : undefined);
              const agentInfo = participant ? slugMap[participant.participantId] : undefined;
              return (
                <MessageCard
                  key={`${msg.id}-${msg.ts}`}
                  message={msg}
                  agentSlug={agentInfo?.slug ?? participant?.agentSlug ?? ''}
                  agentIndex={agentInfo?.index ?? 0}
                  reviewState={reviewState}
                  roomId={roomId}
                  role={participant?.role}
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
          (p) => p.status === 'thinking' && !streamingText.has(p.participantId),
        );
        // Agents actively writing (have streaming text)
        const hasThinking = thinkingAgents.length > 0;
        const hasStreaming = streamingEntries.length > 0;
        if (!hasThinking && !hasStreaming) return null;
        return (
          <div className="px-4 space-y-2 mt-3">
            {thinkingAgents.map((p) => {
              const agentInfo = slugMap[p.participantId];
              return (
                <ThinkingCard
                  key={p.participantId}
                  agentName={p.agentName}
                  agentSlug={agentInfo?.slug ?? ''}
                  agentIndex={agentInfo?.index ?? 0}
                  wave={currentWave}
                  activity={p.activity}
                  role={p.role}
                />
              );
            })}
            {streamingEntries.map(([participantId, text]) => {
              const participant = participants.get(participantId);
              const agentInfo = slugMap[participantId];
              if (!participant) return null;
              return (
                <StreamingCard
                  key={participantId}
                  agentName={participant.agentName}
                  agentSlug={agentInfo?.slug ?? ''}
                  agentIndex={agentInfo?.index ?? 0}
                  text={text}
                  wave={currentWave}
                  role={participant.role}
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

function HistoryLoadingState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
      <div className="size-12 rounded-2xl bg-sky-500/[0.06] border border-sky-500/15 flex items-center justify-center">
        <Loader2 className="size-5 text-sky-300/70 animate-spin" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground/55">Collecting discussion history</p>
        <p className="text-xs text-muted-foreground/30 max-w-xs mx-auto leading-relaxed">
          Replaying saved brainstorm messages so the room opens with its full context.
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
  isInitialCatchupPending = false,
}: {
  roomId: string;
  /** Called when the user taps the participants button on mobile. */
  onOpenMobileSidebar?: () => void;
  isInitialCatchupPending?: boolean;
}) {
  // Individual selectors — each returns a stable primitive or reference.
  // Zustand 5 requires `getSnapshot` to be cached; object selectors `(s) => ({...})`
  // always return new references and cause an infinite useSyncExternalStore loop.
  const messages = useBrainstormStore((s) => s.messages);
  const streamingText = useBrainstormStore((s) => s.streamingText);
  const participants = useBrainstormStore((s) => s.participants);
  const status = useBrainstormStore((s) => s.status);
  const synthesis = useBrainstormStore((s) => s.synthesis);
  const task = useBrainstormStore((s) => s.task);
  const converged = useBrainstormStore((s) => s.converged);
  const maxWavesReached = useBrainstormStore((s) => s.maxWavesReached);
  const currentWave = useBrainstormStore((s) => s.currentWave);
  const reflectionWaves = useBrainstormStore((s) => s.reflectionWaves);
  const reviewState = useBrainstormStore((s) => s.reviewState);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Build slug map from participants for stable color assignment.
  // Memoized so re-renders triggered by streaming text don't rebuild it unnecessarily.
  const slugMap = useMemo(() => {
    const map: SlugMap = {};
    let index = 0;
    for (const [participantId, p] of participants) {
      map[participantId] = { slug: p.agentSlug, index: index++ };
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
  const showHistoryLoader = isInitialCatchupPending && isEmpty;

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
        {showHistoryLoader ? (
          <HistoryLoadingState />
        ) : isEmpty ? (
          <EmptyState status={status} />
        ) : (
          <div className="py-5 space-y-0">
            <MessageList
              messages={messages}
              slugMap={slugMap}
              streamingText={streamingText}
              participants={participants}
              currentWave={currentWave}
              reflectionWaves={reflectionWaves}
              reviewState={reviewState}
              roomId={roomId}
            />
          </div>
        )}

        {/* Status banners */}
        {converged && <ConvergedBanner />}
        {maxWavesReached && !converged && <MaxWavesBanner />}
        {status === 'ended' && <EndedBanner />}

        {/* Synthesis */}
        {synthesis && <SynthesisPanel synthesis={synthesis} taskId={task?.id ?? null} />}

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
