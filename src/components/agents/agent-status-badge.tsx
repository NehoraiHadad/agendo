import { Badge } from '@/components/ui/badge';

interface AgentStatusBadgeProps {
  isActive: boolean;
}

export function AgentStatusBadge({ isActive }: AgentStatusBadgeProps) {
  return (
    <Badge variant={isActive ? 'default' : 'secondary'}>{isActive ? 'Active' : 'Inactive'}</Badge>
  );
}
