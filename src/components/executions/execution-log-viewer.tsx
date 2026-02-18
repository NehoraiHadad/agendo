'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useExecutionStream, type UseExecutionStreamReturn } from '@/hooks/use-execution-stream';
import { getStreamColorClass, type RenderedLine } from '@/lib/log-renderer';
import { ExecutionLogToolbar } from './execution-log-toolbar';
import type { ExecutionStatus } from '@/lib/types';

interface ExecutionLogViewerProps {
  executionId: string;
  initialStatus?: ExecutionStatus;
  enabled?: boolean;
  onStatusChange?: (status: ExecutionStatus) => void;
  externalStream?: UseExecutionStreamReturn;
}

const SCROLL_THRESHOLD = 50;

/**
 * Highlights search matches within pre-sanitized HTML.
 * SECURITY: The `html` parameter has already been sanitized by DOMPurify
 * in log-renderer.ts (ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['style']).
 * The `<mark>` tags added here contain only the matched text from the
 * already-sanitized output, so no XSS vector is introduced.
 */
function highlightMatches(html: string, text: string, query: string): string {
  if (!query) return html;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return html;

  // Find the matching text in original case
  const matchText = text.substring(idx, idx + query.length);
  // Escape special regex chars in the match text
  const escaped = matchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(
    new RegExp(escaped, 'gi'),
    (m) => `<mark class="bg-amber-500/40 text-amber-100 rounded-sm px-0.5">${m}</mark>`,
  );
}

export function ExecutionLogViewer({
  executionId,
  initialStatus,
  enabled = true,
  onStatusChange,
  externalStream,
}: ExecutionLogViewerProps) {
  const internal = useExecutionStream(externalStream ? null : (enabled ? executionId : null));
  const stream = externalStream ?? internal;
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [wrapLines, setWrapLines] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [rawMatchIndex, setRawMatchIndex] = useState(0);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const currentStatus = stream.status ?? initialStatus ?? 'queued';

  // Notify parent of status changes from SSE stream
  useEffect(() => {
    if (stream.status) {
      onStatusChange?.(stream.status);
    }
  }, [stream.status, onStatusChange]);

  // Compute search matches (line indices that match)
  const matchIndices = useMemo(() => {
    if (!searchQuery) return [];
    const lowerQuery = searchQuery.toLowerCase();
    return stream.lines.reduce<number[]>((acc, line, idx) => {
      if (line.text.toLowerCase().includes(lowerQuery)) {
        acc.push(idx);
      }
      return acc;
    }, []);
  }, [stream.lines, searchQuery]);

  // Clamp current match index (derived, no effect needed)
  const currentMatchIndex =
    matchIndices.length === 0 ? 0 : Math.min(rawMatchIndex, matchIndices.length - 1);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [stream.lines.length, autoScroll]);

  // Detect manual scroll-up
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom <= SCROLL_THRESHOLD;
    setShowScrollButton(!isNearBottom);
    if (!isNearBottom && autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll]);

  function scrollToBottom() {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setAutoScroll(true);
      setShowScrollButton(false);
    }
  }

  function handleNextMatch() {
    if (matchIndices.length === 0) return;
    const next = (currentMatchIndex + 1) % matchIndices.length;
    setRawMatchIndex(next);
    scrollToMatchLine(matchIndices[next]);
  }

  function handlePrevMatch() {
    if (matchIndices.length === 0) return;
    const prev = (currentMatchIndex - 1 + matchIndices.length) % matchIndices.length;
    setRawMatchIndex(prev);
    scrollToMatchLine(matchIndices[prev]);
  }

  function scrollToMatchLine(lineIndex: number) {
    const el = containerRef.current;
    if (!el) return;
    const lineEls = el.querySelectorAll('[data-line-index]');
    const target = lineEls[lineIndex] as HTMLElement | undefined;
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setAutoScroll(false);
    }
  }

  /**
   * Renders a single log line.
   * SECURITY: line.html is pre-sanitized by DOMPurify in log-renderer.ts
   * with ALLOWED_TAGS: ['span'] and ALLOWED_ATTR: ['style'].
   */
  function renderLine(line: RenderedLine, index: number) {
    const colorClass = getStreamColorClass(line.stream);
    const isMatch = searchQuery && line.text.toLowerCase().includes(searchQuery.toLowerCase());
    const isCurrentMatch = isMatch && matchIndices[currentMatchIndex] === index;
    // html is sanitized by DOMPurify in log-renderer.ts
    const sanitizedHtml = isMatch ? highlightMatches(line.html, line.text, searchQuery) : line.html;

    return (
      <div
        key={line.id}
        data-line-index={index}
        className={`flex gap-2 px-3 py-px hover:bg-white/5 ${
          isCurrentMatch ? 'bg-amber-500/10 ring-1 ring-amber-500/30' : ''
        }`}
      >
        <span className="select-none text-zinc-600 tabular-nums text-right min-w-[3ch]">
          {index + 1}
        </span>
        {/* Content is sanitized by DOMPurify (ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['style']) */}
        <span
          className={`${colorClass} ${wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-md">
      <ExecutionLogToolbar
        executionId={executionId}
        lineCount={stream.lines.length}
        isTruncated={stream.isTruncated}
        searchQuery={searchQuery}
        onSearchChange={(q) => {
          setSearchQuery(q);
          setRawMatchIndex(0);
        }}
        matchCount={matchIndices.length}
        currentMatch={currentMatchIndex}
        onNextMatch={handleNextMatch}
        onPrevMatch={handlePrevMatch}
        wrapLines={wrapLines}
        onWrapToggle={setWrapLines}
        autoScroll={autoScroll}
        onAutoScrollToggle={setAutoScroll}
        onCopyAll={() => {
          const text = stream.lines.map((l) => l.text).join('\n');
          void navigator.clipboard.writeText(text);
        }}
      />

      <div className="relative">
        {stream.isTruncated && (
          <div className="border-x border-zinc-700 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
            Output truncated to 5,000 lines. Download the full log for complete output.
          </div>
        )}

        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="h-[50dvh] min-h-[320px] overflow-auto border border-zinc-700 bg-[#1a1b26] font-mono text-xs leading-5"
          role="log"
          aria-live="polite"
          aria-label="Execution logs"
        >
          {stream.lines.length === 0 && !stream.error && (
            <div className="flex h-full items-center justify-center text-zinc-500">
              {stream.isConnected ? 'Waiting for output...' : 'Connecting...'}
            </div>
          )}
          {stream.lines.map((line, i) => renderLine(line, i))}
        </div>

        {showScrollButton && (
          <Button
            size="sm"
            variant="secondary"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg"
            onClick={scrollToBottom}
          >
            <ArrowDown className="size-3.5" />
            Scroll to bottom
          </Button>
        )}
      </div>

      {stream.error && (
        <div className="border-x border-b border-zinc-700 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          Stream error: {stream.error}
        </div>
      )}
    </div>
  );
}
