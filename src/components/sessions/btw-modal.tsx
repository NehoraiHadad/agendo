'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Loader2, MessageCircleQuestion, Wrench } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveTool {
  toolName: string;
  toolUseId: string;
}

interface BtwMessage {
  role: 'user' | 'assistant';
  text: string;
  /** True while still streaming — used to show cursor */
  streaming?: boolean;
  /** Tools currently running for this message */
  activeTools?: ActiveTool[];
}

export interface BtwModalProps {
  open: boolean;
  onClose: () => void;
  claudeSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Markdown config — compact, monospace-ish for the side-channel aesthetic
// ---------------------------------------------------------------------------

const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => (
    <p dir="auto" className="mb-1 last:mb-0 leading-relaxed">
      {children}
    </p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-amber-200/90">{children}</strong>,
  em: ({ children }) => <em className="italic text-foreground/70">{children}</em>,
  code: ({ children, className }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return (
        <code className="block font-mono text-[11px] bg-black/40 border border-amber-500/10 rounded px-2.5 py-2 my-1.5 text-amber-100/70 whitespace-pre-wrap overflow-x-auto">
          {children}
        </code>
      );
    }
    return (
      <code className="font-mono text-[11px] bg-amber-500/10 text-amber-200/80 rounded px-1 py-0.5">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="my-1">{children}</pre>,
  ul: ({ children }) => (
    <ul className="list-disc list-inside space-y-0.5 my-1 text-foreground/80 pl-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside space-y-0.5 my-1 text-foreground/80 pl-1">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="text-sm">{children}</li>,
  h1: ({ children }) => (
    <h1 dir="auto" className="text-sm font-bold text-amber-200/90 mb-1 mt-2">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 dir="auto" className="text-sm font-semibold text-amber-200/80 mb-1 mt-2">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 dir="auto" className="text-xs font-semibold text-foreground/80 mb-0.5 mt-1.5">
      {children}
    </h3>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-amber-400/80 underline underline-offset-2 hover:text-amber-300 transition-colors"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-amber-500/30 pl-3 my-1.5 text-foreground/60 italic">
      {children}
    </blockquote>
  ),
};

// ---------------------------------------------------------------------------
// ToolActivity — compact inline indicator for active tools
// ---------------------------------------------------------------------------

interface ToolActivityProps {
  tools: ActiveTool[];
}

function ToolActivity({ tools }: ToolActivityProps) {
  if (tools.length === 0) return null;
  // Show only the most recent active tool to keep it compact
  const tool = tools[tools.length - 1];
  return (
    <div className="flex items-center gap-1.5 mt-1.5 py-1 px-2 rounded bg-amber-500/5 border border-amber-500/10">
      <Wrench
        className="size-2.5 text-amber-500/50 shrink-0"
        style={{ animation: 'btw-blink 1.2s step-start infinite' }}
      />
      <span className="font-mono text-[10px] text-amber-500/50 truncate">{tool.toolName}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BtwModal({ open, onClose, claudeSessionId }: BtwModalProps) {
  const [messages, setMessages] = useState<BtwMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [btwSessionId, setBtwSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset all state when closed — fully ephemeral
  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setBtwSessionId(null);
    setInput('');
    setIsLoading(false);
    setError(null);
    onClose();
  }, [onClose]);

  // Auto-focus input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  // Scroll to bottom on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Keyboard shortcut: Escape to close (Dialog handles this, but abort fetch too)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        abortRef.current?.abort();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  /** Update the streaming assistant message at assistantIndex */
  function patchStreamingMessage(assistantIndex: number, updater: (msg: BtwMessage) => BtwMessage) {
    setMessages((prev) => {
      const next = [...prev];
      const idx = next.findIndex(
        (m, i) => i >= assistantIndex && m.role === 'assistant' && m.streaming,
      );
      if (idx !== -1) {
        next[idx] = updater(next[idx]);
      }
      return next;
    });
  }

  async function handleSend() {
    const question = input.trim();
    if (!question || isLoading) return;

    setInput('');
    setError(null);
    setIsLoading(true);

    // Add user message immediately
    setMessages((prev) => [...prev, { role: 'user', text: question }]);

    // Prepare streaming assistant placeholder
    const assistantIndex = messages.length + 1; // after the user message we just appended
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', text: '', streaming: true, activeTools: [] },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/btw', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, claudeSessionId, btwSessionId }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(errText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lineBuffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let data: { type: string; [key: string]: unknown };
          try {
            data = JSON.parse(line) as { type: string; [key: string]: unknown };
          } catch {
            continue;
          }

          if (data.type === 'init' && typeof data.btwSessionId === 'string') {
            setBtwSessionId(data.btwSessionId);
          } else if (data.type === 'text' && typeof data.content === 'string') {
            accumulated += data.content;
            const snapshot = accumulated;
            patchStreamingMessage(assistantIndex, (m) => ({ ...m, text: snapshot }));
          } else if (
            data.type === 'tool-start' &&
            typeof data.toolName === 'string' &&
            typeof data.toolUseId === 'string'
          ) {
            const newTool: ActiveTool = { toolName: data.toolName, toolUseId: data.toolUseId };
            patchStreamingMessage(assistantIndex, (m) => ({
              ...m,
              activeTools: [
                ...(m.activeTools ?? []).filter((t) => t.toolUseId !== data.toolUseId),
                newTool,
              ],
            }));
          } else if (data.type === 'tool-end' && typeof data.toolUseId === 'string') {
            patchStreamingMessage(assistantIndex, (m) => ({
              ...m,
              activeTools: (m.activeTools ?? []).filter((t) => t.toolUseId !== data.toolUseId),
            }));
          } else if (data.type === 'done' && typeof data.fullText === 'string') {
            setMessages((prev) => {
              const next = [...prev];
              const idx = next.findIndex(
                (m, i) => i >= assistantIndex && m.role === 'assistant' && m.streaming,
              );
              if (idx !== -1) {
                next[idx] = {
                  role: 'assistant',
                  text: data.fullText as string,
                  streaming: false,
                  activeTools: [],
                };
              }
              return next;
            });
          } else if (data.type === 'error' && typeof data.message === 'string') {
            setError(data.message);
            // Remove the streaming placeholder
            setMessages((prev) => prev.filter((m) => !m.streaming));
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const msg = err instanceof Error ? err.message : 'Something went wrong';
        setError(msg);
      }
      // Remove any streaming placeholder
      setMessages((prev) => prev.filter((m) => !m.streaming));
    } finally {
      setIsLoading(false);
      abortRef.current = null;
      // Finalize any still-streaming message (in case done event was missed)
      setMessages((prev) =>
        prev.map((m) => (m.streaming ? { ...m, streaming: false, activeTools: [] } : m)),
      );
      // Re-focus input
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const isDisabled = !claudeSessionId;
  const canSend = !isLoading && !isDisabled && input.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 border border-amber-500/[0.12] bg-[oklch(0.08_0.005_60)] shadow-2xl shadow-black/60 flex flex-col max-h-[85vh] sm:max-h-[80vh]"
        style={{
          background:
            'radial-gradient(ellipse at top left, oklch(0.10 0.008 60) 0%, oklch(0.07 0.003 60) 100%)',
        }}
      >
        {/* ── Header ── */}
        <DialogHeader className="shrink-0 px-4 pt-4 pb-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative flex items-center justify-center size-7 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <MessageCircleQuestion className="size-3.5 text-amber-400/80" />
                {/* Subtle glow dot */}
                <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-400 ring-1 ring-amber-400/20" />
              </div>
              <div>
                <DialogTitle className="font-mono text-sm font-semibold text-amber-300/90 tracking-tight">
                  btw
                </DialogTitle>
                <p className="text-[10px] text-amber-500/40 font-mono -mt-0.5">
                  side channel · nothing saved
                </p>
              </div>
            </div>
            {/* Session ID chip */}
            {claudeSessionId && (
              <span className="font-mono text-[9px] text-amber-500/25 bg-amber-500/5 border border-amber-500/10 rounded px-1.5 py-0.5 hidden sm:inline-block">
                {claudeSessionId.slice(0, 12)}…
              </span>
            )}
          </div>

          {/* Divider with gradient */}
          <div className="mt-3 h-px bg-gradient-to-r from-amber-500/20 via-amber-500/8 to-transparent" />
        </DialogHeader>

        {/* ── Message list — flex-1 so it fills remaining space and scrolls ── */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
          <div className="px-4 py-3 space-y-4">
            {messages.length === 0 && !isDisabled && (
              <div className="flex flex-col items-center justify-center py-8 gap-2">
                <div className="size-8 rounded-full bg-amber-500/8 border border-amber-500/12 flex items-center justify-center">
                  <MessageCircleQuestion className="size-4 text-amber-500/30" />
                </div>
                <p className="text-xs text-amber-500/30 font-mono text-center">
                  ask anything about the session
                  <br />
                  <span className="text-amber-500/20">context-aware · ephemeral</span>
                </p>
              </div>
            )}

            {isDisabled && (
              <div className="flex items-center gap-2 py-4 px-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                <Loader2 className="size-3.5 text-amber-500/40 animate-spin shrink-0" />
                <p className="text-xs text-amber-500/50 font-mono">
                  Waiting for session to initialize…
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'user' ? (
                  /* User bubble */
                  <div
                    className="max-w-[80%] rounded-2xl rtl:rounded-bl-sm ltr:rounded-br-sm px-3.5 py-2.5"
                    style={{
                      background:
                        'linear-gradient(135deg, oklch(0.35 0.08 60 / 0.7), oklch(0.28 0.06 60 / 0.6))',
                      border: '1px solid oklch(0.5 0.1 60 / 0.25)',
                    }}
                  >
                    <p
                      dir="auto"
                      className="text-sm text-amber-100/90 leading-relaxed whitespace-pre-wrap break-words"
                    >
                      {msg.text}
                    </p>
                  </div>
                ) : (
                  /* Assistant message */
                  <div dir="auto" className="max-w-[88%] space-y-0">
                    {/* Tiny role label */}
                    <p className="text-[9px] font-mono text-amber-500/30 mb-1 ms-0.5 uppercase tracking-wider">
                      claude
                    </p>
                    <div className="text-sm text-foreground/85 leading-relaxed">
                      {msg.text ? (
                        <div dir="auto" className="prose-sm prose-invert max-w-none">
                          <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm]}>
                            {msg.text}
                          </ReactMarkdown>
                        </div>
                      ) : null}
                      {/* Active tool indicator — shown below streaming text */}
                      {msg.streaming && msg.activeTools && msg.activeTools.length > 0 && (
                        <ToolActivity tools={msg.activeTools} />
                      )}
                      {msg.streaming && (
                        /* Animated cursor while streaming */
                        <span className="inline-flex items-end gap-0.5 ms-0.5 align-baseline">
                          <span
                            className="inline-block w-1.5 h-3 bg-amber-400/60 rounded-sm"
                            style={{ animation: 'btw-blink 0.9s step-start infinite' }}
                          />
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Inline error */}
            {error && (
              <div className="rounded-lg px-3 py-2 bg-red-500/10 border border-red-500/20">
                <p className="text-xs text-red-400/80 font-mono">{error}</p>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* ── Input area ── */}
        <div className="shrink-0 border-t border-amber-500/[0.08] px-3 pb-3 pt-2.5">
          <div
            className="flex items-end gap-2 rounded-xl border bg-black/20 px-3 py-2 transition-colors focus-within:border-amber-500/25"
            style={{ borderColor: 'oklch(0.5 0.1 60 / 0.12)' }}
          >
            <textarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isDisabled
                  ? 'Waiting for session…'
                  : messages.length === 0
                    ? 'Ask a quick question…'
                    : 'Ask a follow-up…'
              }
              disabled={isDisabled || isLoading}
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm text-foreground/90 placeholder:text-amber-500/25 focus:outline-none disabled:opacity-40 leading-relaxed min-h-[24px] max-h-[120px] overflow-y-auto py-0.5"
              style={{ fieldSizing: 'content' } as React.CSSProperties}
            />
            <Button
              size="icon"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className="size-7 shrink-0 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 hover:text-amber-300 border border-amber-500/20 hover:border-amber-500/35 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
              aria-label="Send"
            >
              {isLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-amber-500/20 font-mono text-center">
            Esc to dismiss · ephemeral — nothing saved
          </p>
        </div>
      </DialogContent>

      {/* Inline keyframes */}
      <style>{`
        @keyframes btw-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </Dialog>
  );
}
