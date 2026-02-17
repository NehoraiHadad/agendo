'use client';

import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-types';
import type { ExecutionStatus } from '@/lib/types';

interface ExecutionMessageInputProps {
  executionId: string;
  status?: ExecutionStatus;
}

export function ExecutionMessageInput({ executionId, status }: ExecutionMessageInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);

  // When status is not provided, always show (parent controls visibility)
  const isDisabled = status !== undefined && status !== 'running';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isSending || isDisabled) return;

    setIsSending(true);
    try {
      await apiFetch(`/api/executions/${executionId}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: trimmed }),
      });
      setMessage('');
    } catch {
      // Message errors are transient; user can retry
    } finally {
      setIsSending(false);
    }
  }

  if (isDisabled) {
    return null;
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 border-t border-zinc-700 bg-zinc-900 px-3 py-2"
    >
      <Input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Send a message to the agent..."
        className="h-8 flex-1 bg-zinc-800 border-zinc-700 text-xs text-zinc-100"
        disabled={isSending}
      />
      <Button
        type="submit"
        size="icon-xs"
        disabled={!message.trim() || isSending}
        aria-label="Send message"
      >
        {isSending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
      </Button>
    </form>
  );
}
