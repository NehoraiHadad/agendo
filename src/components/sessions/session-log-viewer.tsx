'use client';

import { useEffect, useRef } from 'react';
import { getStreamColorClass } from '@/lib/log-renderer';
import type { UseSessionLogStreamReturn } from '@/hooks/use-session-log-stream';

interface SessionLogViewerProps {
  stream: UseSessionLogStreamReturn;
}

export function SessionLogViewer({ stream }: SessionLogViewerProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stream.lines.length]);

  if (!stream.isConnected && stream.lines.length === 0 && !stream.isDone) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-white/[0.06] bg-[oklch(0.07_0_0)]">
        <p className="text-sm text-muted-foreground/50">Connecting to log stream…</p>
      </div>
    );
  }

  if (stream.error) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-destructive/20 bg-destructive/5">
        <p className="text-sm text-destructive/70">{stream.error}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-[oklch(0.06_0_0)] p-3 font-mono text-xs">
      {stream.isTruncated && (
        <p className="mb-2 text-amber-400/60 text-center text-[10px]">
          [Log truncated — showing last 5000 lines]
        </p>
      )}
      {stream.lines.length === 0 ? (
        <p className="text-muted-foreground/40">No log output yet.</p>
      ) : (
        stream.lines.map((line) => (
          <div
            key={line.id}
            // line.html is pre-sanitized by DOMPurify in log-renderer.ts (ALLOWED_TAGS: span, ALLOWED_ATTR: style)
            dangerouslySetInnerHTML={{ __html: line.html }}
            className={`leading-5 whitespace-pre-wrap break-all ${getStreamColorClass(line.stream)}`}
          />
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
