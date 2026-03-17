'use client';

import { useState } from 'react';
import { Clock, Pencil, X } from 'lucide-react';

interface PendingMessagePillProps {
  text: string;
  imageDataUrl?: string;
  onEdit: () => void;
  onCancel: () => void;
}

const PREVIEW_LEN = 80;

export function PendingMessagePill({
  text,
  imageDataUrl,
  onEdit,
  onCancel,
}: PendingMessagePillProps) {
  const [hovered, setHovered] = useState(false);
  const isLong = text.length > PREVIEW_LEN;
  const preview = isLong ? text.slice(0, PREVIEW_LEN) + '…' : text;

  return (
    <div
      className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/[0.06] px-3 py-2 text-xs shadow-sm animate-in slide-in-from-bottom-2 duration-200"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Clock className="size-3.5 shrink-0 text-primary/50 animate-pulse" />

      {imageDataUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageDataUrl}
          alt="queued attachment"
          className="size-6 rounded object-cover border border-white/10 shrink-0"
        />
      )}

      <span className="flex-1 truncate text-foreground/70" dir="auto" title={text}>
        {preview}
      </span>

      <span className="shrink-0 text-[10px] text-muted-foreground/40">
        {hovered ? '' : 'Queued'}
      </span>

      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 rounded-md p-1 text-muted-foreground/50 hover:text-primary hover:bg-primary/10 transition-colors"
        aria-label="Edit queued message"
        title="Edit"
      >
        <Pencil className="size-3" />
      </button>

      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-md p-1 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
        aria-label="Cancel queued message"
        title="Cancel"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
