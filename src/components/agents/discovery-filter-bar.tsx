'use client';

import { Button } from '@/components/ui/button';

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'ai-agent', label: 'AI Agents' },
  { value: 'cli-tool', label: 'CLI Tools' },
  { value: 'admin-tool', label: 'Admin Tools' },
  { value: 'interactive-tui', label: 'TUI Apps' },
  { value: 'daemon', label: 'Daemons' },
  { value: 'shell-util', label: 'Shell Utils' },
] as const;

export type FilterValue = (typeof FILTER_OPTIONS)[number]['value'];

interface DiscoveryFilterBarProps {
  activeFilter: FilterValue;
  onFilterChange: (filter: FilterValue) => void;
  counts: Record<string, number>;
}

export function DiscoveryFilterBar({
  activeFilter,
  onFilterChange,
  counts,
}: DiscoveryFilterBarProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {FILTER_OPTIONS.map((option) => {
        const count =
          option.value === 'all'
            ? Object.values(counts).reduce((sum, c) => sum + c, 0)
            : (counts[option.value] ?? 0);

        return (
          <Button
            key={option.value}
            variant={activeFilter === option.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => onFilterChange(option.value)}
          >
            {option.label}
            <span className="ml-1.5 text-xs opacity-70">({count})</span>
          </Button>
        );
      })}
    </div>
  );
}
