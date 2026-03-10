'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { TableRow, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { AgentStatusBadge } from './agent-status-badge';
import { deleteAgentAction } from '@/lib/actions/agent-actions';
import { Pencil, Trash2 } from 'lucide-react';
import type { Agent } from '@/lib/types';

interface AgentRowProps {
  agent: Agent;
}

export function AgentRow({ agent }: AgentRowProps) {
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    if (!window.confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) {
      return;
    }
    startTransition(async () => {
      await deleteAgentAction(agent.id);
    });
  }

  return (
    <TableRow className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
      <TableCell className="font-medium text-foreground">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${agent.isActive ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}
          />
          <Link href={`/agents/${agent.id}`} className="hover:text-primary transition-colors">
            {agent.name}
          </Link>
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell font-mono text-xs text-muted-foreground/60 max-w-48 truncate">
        {agent.binaryPath}
      </TableCell>
      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground/60">
        {agent.toolType ?? '-'}
      </TableCell>
      <TableCell>
        <AgentStatusBadge isActive={agent.isActive} />
      </TableCell>
      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground/60">
        {agent.version ?? '-'}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" asChild>
            <Link href={`/agents/${agent.id}`} aria-label="Edit agent">
              <Pencil className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={handleDelete}
            disabled={isPending}
            aria-label="Delete agent"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
