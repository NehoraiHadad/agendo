import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AgentRow } from './agent-row';
import type { Agent } from '@/lib/types';

interface AgentTableProps {
  agents: Agent[];
}

export function AgentTable({ agents }: AgentTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10" />
          <TableHead>Name</TableHead>
          <TableHead>Binary Path</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Version</TableHead>
          <TableHead className="w-20">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </TableBody>
    </Table>
  );
}
