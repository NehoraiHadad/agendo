'use client';

import { Badge } from '@/components/ui/badge';
import { ShieldCheck, Shield, ShieldAlert, ShieldBan } from 'lucide-react';
import type { AgentCapability } from '@/lib/types';

interface CapabilityRowProps {
  capability: AgentCapability;
}

const DANGER_ICONS = [
  { Icon: ShieldCheck, className: 'text-green-600' },
  { Icon: Shield, className: 'text-yellow-600' },
  { Icon: ShieldAlert, className: 'text-orange-600' },
  { Icon: ShieldBan, className: 'text-red-600' },
] as const;

export function CapabilityRow({ capability }: CapabilityRowProps) {
  const dangerIndex = Math.min(capability.dangerLevel, 3);
  const { Icon: DangerIcon, className: dangerClassName } = DANGER_ICONS[dangerIndex];

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
      <div className="flex items-center gap-3 min-w-0">
        <DangerIcon className={`h-4 w-4 shrink-0 ${dangerClassName}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{capability.label}</span>
            {!capability.isEnabled && (
              <Badge variant="secondary" className="text-xs">Disabled</Badge>
            )}
          </div>
          {capability.description && (
            <p className="text-xs text-muted-foreground truncate max-w-md">
              {capability.description}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge
          variant="outline"
          className={
            capability.interactionMode === 'template'
              ? 'border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300'
              : 'border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-300'
          }
        >
          {capability.interactionMode === 'template' ? 'Template' : 'Prompt'}
        </Badge>
        <Badge variant="outline" className="text-xs">
          {capability.source}
        </Badge>
      </div>
    </div>
  );
}
