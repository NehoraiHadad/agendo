'use client';

import { useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-types';
import type { ExecutionStatus } from '@/lib/types';

interface ExecutionCancelButtonProps {
  executionId: string;
  status: ExecutionStatus;
  onCancelled?: () => void;
}

const CANCELLABLE_STATUSES: ExecutionStatus[] = ['running', 'queued'];

export function ExecutionCancelButton({
  executionId,
  status,
  onCancelled,
}: ExecutionCancelButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  if (!CANCELLABLE_STATUSES.includes(status)) {
    return null;
  }

  async function handleCancel() {
    const confirmed = window.confirm(
      'Are you sure you want to cancel this execution? This action cannot be undone.',
    );
    if (!confirmed) return;

    setIsLoading(true);
    try {
      await apiFetch(`/api/executions/${executionId}/cancel`, {
        method: 'POST',
      });
      onCancelled?.();
    } catch {
      // Error is handled by the parent through status updates
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Button variant="destructive" size="sm" onClick={handleCancel} disabled={isLoading}>
      {isLoading ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
      Cancel
    </Button>
  );
}
