'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { ExternalLink, X, RotateCcw, Loader2, Send, ChevronRight, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useGuideStore } from '@/lib/store/guide-store';
import { useSessionStream } from '@/hooks/use-session-stream';
import { apiFetch } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { AgendoEvent } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Guide marker parser
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
  return text.replace(/\[GUIDE:\s*.+?\]\n?/g, '').trim();
}

// ---------------------------------------------------------------------------
// Guide breadcrumb inline component
// ---------------------------------------------------------------------------

function GuideBreadcrumb({
  steps,
  onFollowGuide,
}: {
  steps: string[];
  onFollowGuide?: (steps: string[]) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onFollowGuide?.(steps)}
      className="flex items-center gap-1 flex-wrap mt-1.5 mb-0.5 group/guide cursor-pointer hover:opacity-80 transition-opacity"
      title="Tap to see the highlighted path"
    >
      {steps.map((step, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
          <span className="text-xs font-medium text-primary/90 bg-primary/10 rounded px-1.5 py-0.5 group-hover/guide:bg-primary/20 transition-colors">
            {step}
          </span>
        </span>
      ))}
      <ExternalLink className="h-3 w-3 text-primary/40 group-hover/guide:text-primary/70 transition-colors ml-1" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Markdown config (simplified from session-chat-view)
// ---------------------------------------------------------------------------

const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => <p className="mb-1 last:mb-0 leading-relaxed text-[13px]">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  ul: ({ children }) => (
    <ul className="list-disc list-inside space-y-0.5 my-1 text-[13px]">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside space-y-0.5 my-1 text-[13px]">{children}</ol>
  ),
  code: ({ children, className }) => {
    if (className) {
      return (
        <pre className="bg-black/30 rounded p-2 my-1 overflow-x-auto text-[12px]">
          <code>{children}</code>
        </pre>
      );
    }
    return (
      <code className="bg-white/[0.06] rounded px-1 py-0.5 text-[12px] font-mono">{children}</code>
    );
  },
};

// ---------------------------------------------------------------------------
// Agent picker (setup view)
// ---------------------------------------------------------------------------

interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

function AgentPicker({
  agents,
  selected,
  onSelect,
}: {
  agents: AgentOption[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onSelect(a.id)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
            selected === a.id
              ? 'bg-primary/15 text-primary border border-primary/30'
              : 'bg-white/[0.04] text-muted-foreground/60 border border-white/[0.06] hover:bg-white/[0.08] hover:text-foreground/70',
          )}
        >
          <Sparkles className="h-3 w-3" />
          {a.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message list
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: number;
  role: 'assistant' | 'user' | 'system';
  text: string;
  guideSteps?: string[] | null;
}

function buildMessages(events: AgendoEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const ev of events) {
    if (ev.type === 'agent:text') {
      const guide = parseGuideMarker(ev.text);
      const cleaned = stripGuideMarkers(ev.text);
      if (cleaned) {
        messages.push({ id: ev.id, role: 'assistant', text: cleaned, guideSteps: guide });
      }
    } else if (ev.type === 'user:message') {
      messages.push({ id: ev.id, role: 'user', text: ev.text });
    } else if (ev.type === 'system:error') {
      messages.push({ id: ev.id, role: 'system', text: ev.message });
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Main popup component
// ---------------------------------------------------------------------------

interface SupportChatPopupProps {
  onClose: () => void;
}

export function SupportChatPopup({ onClose }: SupportChatPopupProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [message, setMessage] = useState('');
  const [isCreating, setCreating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { events, sessionStatus } = useSessionStream(sessionId);
  const messages = useMemo(() => buildMessages(events), [events]);

  // Trigger guide store when new guide steps arrive
  const lastGuideRef = useRef<string | null>(null);
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.guideSteps) {
        const key = m.guideSteps.join('→');
        if (key !== lastGuideRef.current) {
          lastGuideRef.current = key;
          useGuideStore.getState().setGuide(m.guideSteps);
        }
        break;
      }
    }
  }, [messages]);

  // Fetch agents on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/agents?group=ai&pageSize=20');
        const json = await res.json();
        const list: AgentOption[] = (json.data ?? []).map(
          (a: { id: string; name: string; slug: string }) => ({
            id: a.id,
            name: a.name,
            slug: a.slug,
          }),
        );
        setAgents(list);
        // Auto-select Claude if available
        const claude = list.find((a) => a.slug.startsWith('claude'));
        if (claude) setAgentId(claude.id);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleStartSession = useCallback(async () => {
    if (!agentId || !message.trim()) return;
    setCreating(true);
    try {
      const json = await apiFetch<{ data: { id: string } }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          agentId,
          kind: 'support',
          permissionMode: 'bypassPermissions',
          initialPrompt: message.trim(),
        }),
      });
      setSessionId(json.data.id);
      setMessage('');
    } catch {
      /* ignore */
    } finally {
      setCreating(false);
    }
  }, [agentId, message]);

  const handleSendMessage = useCallback(async () => {
    if (!sessionId || !message.trim() || isSending) return;
    const text = message.trim();
    setMessage('');
    setIsSending(true);
    try {
      await apiFetch(`/api/sessions/${sessionId}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });
    } catch {
      // Restore message on failure
      setMessage(text);
    } finally {
      setIsSending(false);
    }
  }, [sessionId, message, isSending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (sessionId) handleSendMessage();
        else handleStartSession();
      }
    },
    [sessionId, handleSendMessage, handleStartSession],
  );

  // Use sessionStatus as the authoritative source for thinking state.
  // Event-based scanning is unreliable because SSE replays historical
  // agent:activity events that can be stale after the session goes idle.
  const isThinking = sessionStatus === 'active';

  const canSend =
    message.trim().length > 0 &&
    !isSending &&
    !isCreating &&
    (sessionId
      ? sessionStatus === 'awaiting_input' ||
        sessionStatus === 'idle' ||
        sessionStatus === 'active' ||
        sessionStatus === 'ended'
      : true);

  const handleFollowGuide = useCallback((steps: string[]) => {
    useGuideStore.getState().setGuide(steps);
    setMinimized(true);
  }, []);

  // Minimized pill — shows at bottom of screen so user can see highlighted elements
  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 rounded-full bg-primary/15 backdrop-blur-md border border-primary/25 px-4 py-2.5 shadow-lg hover:bg-primary/20 transition-colors animate-fade-in-up"
      >
        <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
        <span className="text-xs font-medium text-foreground/80">Back to Support</span>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 sm:inset-auto sm:bottom-6 sm:right-6 z-[60] sm:w-[360px] sm:h-[520px] flex flex-col sm:rounded-2xl border-0 sm:border border-white/[0.08] bg-[oklch(0.09_0_0)] shadow-2xl overflow-hidden animate-fade-in-up">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02] shrink-0">
        <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
        <span className="text-sm font-semibold text-foreground/90 flex-1">Support</span>
        {sessionId && (
          <>
            <a
              href={`/sessions/${sessionId}`}
              target="_blank"
              rel="noreferrer"
              className="p-1 rounded hover:bg-white/[0.06] text-muted-foreground/50 hover:text-foreground/70 transition-colors"
              title="Open full session"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              onClick={() => setSessionId(null)}
              className="p-1 rounded hover:bg-white/[0.06] text-muted-foreground/50 hover:text-foreground/70 transition-colors"
              title="New conversation"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        <button
          onClick={() => {
            useGuideStore.getState().clearGuide();
            onClose();
          }}
          className="p-1 rounded hover:bg-white/[0.06] text-muted-foreground/50 hover:text-foreground/70 transition-colors"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body */}
      {!sessionId ? (
        /* Setup view */
        <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/50 uppercase tracking-wider font-medium">
              Choose an agent
            </p>
            <AgentPicker agents={agents} selected={agentId} onSelect={setAgentId} />
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground/50 uppercase tracking-wider font-medium">
              Quick start
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMessage('Help me find a setting in the app')}
                className="text-xs px-3 py-1.5 rounded-full bg-primary/10 text-primary/80 border border-primary/15 hover:bg-primary/15 transition-colors"
              >
                Find a setting
              </button>
              <button
                type="button"
                onClick={() => setMessage('I want to report a bug')}
                className="text-xs px-3 py-1.5 rounded-full bg-destructive/10 text-destructive/80 border border-destructive/15 hover:bg-destructive/15 transition-colors"
              >
                Report a bug
              </button>
            </div>
          </div>

          <div className="flex-1" />
        </div>
      ) : (
        /* Chat view */
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                'max-w-[90%] rounded-xl px-3 py-2',
                m.role === 'user'
                  ? 'ml-auto bg-primary/15 text-foreground/90'
                  : m.role === 'system'
                    ? 'bg-destructive/10 text-destructive/80 text-xs'
                    : 'bg-white/[0.04] text-foreground/85',
              )}
            >
              {m.role === 'assistant' ? (
                <>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {m.text}
                  </ReactMarkdown>
                  {m.guideSteps && (
                    <GuideBreadcrumb steps={m.guideSteps} onFollowGuide={handleFollowGuide} />
                  )}
                </>
              ) : (
                <p className="text-[13px] whitespace-pre-wrap">{m.text}</p>
              )}
            </div>
          ))}
          {isThinking && (
            <div className="flex items-center gap-1.5 px-3 py-2">
              <div className="flex gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot" />
                <span
                  className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot"
                  style={{ animationDelay: '0.2s' }}
                />
                <span
                  className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot"
                  style={{ animationDelay: '0.4s' }}
                />
              </div>
              <span className="text-xs text-muted-foreground/40">Thinking...</span>
            </div>
          )}
        </div>
      )}

      {/* Input bar */}
      <div className="border-t border-white/[0.06] p-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={sessionId ? 'Type a message...' : 'What do you need help with?'}
            rows={1}
            className="flex-1 resize-none bg-white/[0.04] rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/30 border border-white/[0.06] focus:outline-none focus:border-primary/30 transition-colors"
            style={{ maxHeight: 80 }}
          />
          <button
            disabled={!canSend}
            onClick={sessionId ? handleSendMessage : handleStartSession}
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all',
              canSend
                ? 'bg-primary/20 text-primary hover:bg-primary/30'
                : 'bg-white/[0.04] text-muted-foreground/20',
            )}
          >
            {isCreating || isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
