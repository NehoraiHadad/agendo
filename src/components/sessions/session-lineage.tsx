'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export interface SessionLineageProps {
  parentSessionId: string;
  parentAgentName: string;
  parentTurns: number | null;
  currentAgentName: string;
}

export function SessionLineage({
  parentSessionId,
  parentAgentName,
  parentTurns,
  currentAgentName,
}: SessionLineageProps) {
  const turnsLabel = parentTurns !== null ? `${parentTurns} turns` : '? turns';

  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground/50">
      <Link
        href={`/sessions/${parentSessionId}`}
        className="hover:text-muted-foreground/80 transition-colors underline-offset-2 hover:underline"
      >
        {parentAgentName}
        <span className="ml-0.5 opacity-60">({turnsLabel})</span>
      </Link>
      <ArrowRight className="size-2.5 text-muted-foreground/30 shrink-0" />
      <span>{currentAgentName}</span>
      <span className="text-muted-foreground/30">(current)</span>
    </span>
  );
}
