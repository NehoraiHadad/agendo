'use client';

import { useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ArrowLeft, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

const WebTerminal = dynamic(
  () => import('@/components/terminal/web-terminal').then((m) => m.WebTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center bg-[#1a1b26]">
        <span className="text-sm text-zinc-400">Loading terminal...</span>
      </div>
    ),
  },
);

interface TerminalPageClientProps {
  executionId: string;
  agentName: string;
  capabilityLabel: string;
}

export function TerminalPageClient({
  executionId,
  agentName,
  capabilityLabel,
}: TerminalPageClientProps) {
  const [fontSize, setFontSize] = useState(14);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <Link href={`/executions/${executionId}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <p className="text-sm font-medium">
              {agentName} / {capabilityLabel}
            </p>
            <p className="font-mono text-xs text-muted-foreground">{executionId.slice(0, 8)}</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setFontSize((s) => Math.max(10, s - 2))}
          >
            <Minus className="h-3 w-3" />
          </Button>
          <span className="w-8 text-center text-xs text-muted-foreground">{fontSize}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setFontSize((s) => Math.min(24, s + 2))}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Terminal */}
      <WebTerminal executionId={executionId} fontSize={fontSize} className="flex-1" />
    </div>
  );
}
