'use client';

import { useRef, useCallback, useState } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { BrainstormRoomStatus } from '@/lib/realtime/event-types';
import { getErrorMessage } from '@/lib/utils/error-utils';

interface ComposeBarProps {
  roomId: string;
  status: BrainstormRoomStatus;
}

const MAX_HEIGHT_PX = 128;

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT_PX) + 'px';
}

function getPlaceholder(status: BrainstormRoomStatus): string {
  switch (status) {
    case 'active':
      return 'Steer the conversation... (Enter to send)';
    case 'paused':
      return 'Continue the discussion... (sends + resumes)';
    case 'waiting':
      return 'Type to start the brainstorm... (Enter to send + start)';
    case 'ended':
      return 'Type to restart... (Enter to send + restart)';
    case 'synthesizing':
      return 'Synthesis in progress...';
  }
}

export function ComposeBar({ roomId, status }: ComposeBarProps) {
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDisabled = status === 'synthesizing';

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isSending || isDisabled) return;

    setIsSending(true);
    try {
      // For non-active rooms, start/restart first, then steer
      if (status === 'waiting' || status === 'ended' || status === 'paused') {
        // Start the brainstorm (works for waiting, ended, paused)
        const startRes = await fetch(`/api/brainstorms/${roomId}/start`, {
          method: 'POST',
        });
        if (!startRes.ok) {
          const body = (await startRes.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Failed to start brainstorm (HTTP ${startRes.status})`);
        }
      }

      // Send the steer message
      const res = await fetch(`/api/brainstorms/${roomId}/steer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsSending(false);
    }
  }, [text, isSending, isDisabled, roomId, status]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    autoGrow(e.target);
  }, []);

  const canSend = text.trim().length > 0 && !isDisabled && !isSending;

  return (
    <div
      className="shrink-0 border-t border-white/[0.06] bg-[oklch(0.075_0.002_280)] px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      role="region"
      aria-label="Message composer"
    >
      {/* Synthesis state helper */}
      {status === 'synthesizing' && (
        <p className="text-[10px] text-muted-foreground/30 text-center mb-2">
          Synthesis in progress
        </p>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          dir="auto"
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={getPlaceholder(status)}
          disabled={isDisabled || isSending}
          rows={1}
          className="flex-1 min-h-[40px] max-h-32 resize-none rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 disabled:opacity-40 transition-[border-color,box-shadow] leading-tight overflow-y-auto"
          autoComplete="off"
          spellCheck={false}
          aria-label="Steering message"
        />
        <Button
          size="icon"
          onClick={() => void handleSend()}
          disabled={!canSend}
          className="shrink-0 h-10 w-10 rounded-xl transition-all duration-150 disabled:opacity-30 disabled:shadow-none hover:scale-105 active:scale-95"
          aria-label="Send message"
        >
          {isSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
