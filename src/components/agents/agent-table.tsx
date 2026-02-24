import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AgentRow } from './agent-row';
import type { Agent } from '@/lib/types';

interface AgentTableProps {
  agents: Agent[];
}

export function AgentTable({ agents }: AgentTableProps) {
  return (
    <div className="rounded-xl border border-white/[0.06] overflow-hidden overflow-x-auto">
      <Table className="min-w-[500px]">
        <TableHeader className="bg-white/[0.02]">
          <TableRow>
            <TableHead className="w-10 text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9" />
            <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
              Name
            </TableHead>
            <TableHead className="hidden md:table-cell text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
              Binary Path
            </TableHead>
            <TableHead className="hidden sm:table-cell text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
              Type
            </TableHead>
            <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
              Status
            </TableHead>
            <TableHead className="hidden sm:table-cell text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
              Version
            </TableHead>
            <TableHead className="w-20 text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
