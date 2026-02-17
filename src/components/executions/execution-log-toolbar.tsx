'use client';

import { useState, useCallback } from 'react';
import { Search, ChevronUp, ChevronDown, Download, WrapText, ArrowDownToLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ExecutionLogToolbarProps {
  executionId: string;
  lineCount: number;
  isTruncated: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  matchCount: number;
  currentMatch: number;
  onNextMatch: () => void;
  onPrevMatch: () => void;
  wrapLines: boolean;
  onWrapToggle: (wrap: boolean) => void;
  autoScroll: boolean;
  onAutoScrollToggle: (auto: boolean) => void;
}

export function ExecutionLogToolbar({
  executionId,
  lineCount,
  isTruncated,
  searchQuery,
  onSearchChange,
  matchCount,
  currentMatch,
  onNextMatch,
  onPrevMatch,
  wrapLines,
  onWrapToggle,
  autoScroll,
  onAutoScrollToggle,
}: ExecutionLogToolbarProps) {
  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    try {
      const res = await fetch(`/api/executions/${executionId}/logs`);
      if (!res.ok) throw new Error('Download failed');
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `execution-${executionId}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Download errors are non-critical
    } finally {
      setIsDownloading(false);
    }
  }, [executionId]);

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2 rounded-t-md border border-b-0 border-zinc-700 bg-zinc-900 px-3 py-2">
        {/* Search */}
        <div className="flex flex-1 items-center gap-1">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search logs..."
              className="h-7 bg-zinc-800 border-zinc-700 pl-8 text-xs text-zinc-100"
            />
          </div>
          {searchQuery && (
            <>
              <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : 'No matches'}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onPrevMatch}
                disabled={matchCount === 0}
                aria-label="Previous match"
              >
                <ChevronUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onNextMatch}
                disabled={matchCount === 0}
                aria-label="Next match"
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </>
          )}
        </div>

        {/* Toggles and actions */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                pressed={wrapLines}
                onPressedChange={onWrapToggle}
                aria-label="Toggle word wrap"
                className="size-7 p-0"
              >
                <WrapText className="size-3.5" />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>Word wrap</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                pressed={autoScroll}
                onPressedChange={onAutoScrollToggle}
                aria-label="Toggle auto-scroll"
                className="size-7 p-0"
              >
                <ArrowDownToLine className="size-3.5" />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>Auto-scroll</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleDownload}
                disabled={isDownloading}
                aria-label="Download logs"
              >
                <Download className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download logs</TooltipContent>
          </Tooltip>
        </div>

        {/* Line count */}
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {lineCount.toLocaleString()} lines
          {isTruncated && ' (truncated)'}
        </span>
      </div>
    </TooltipProvider>
  );
}
