'use client';

import { Info, Users } from 'lucide-react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DELEGATION_POLICY_OPTIONS, type DelegationPolicy } from '@/lib/utils/session-controls';

interface DelegationPolicySelectProps {
  value: DelegationPolicy;
  onValueChange: (value: DelegationPolicy) => void;
  /** Use compact label style (uppercase tracking-wider) for quick-launch dialog */
  variant?: 'default' | 'compact';
}

export function DelegationPolicySelect({
  value,
  onValueChange,
  variant = 'default',
}: DelegationPolicySelectProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {variant === 'compact' ? (
          <Label className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Users className="size-3.5" />
            Team Delegation
          </Label>
        ) : (
          <Label className="flex items-center gap-1.5">
            <Users className="size-3.5 text-muted-foreground" />
            Team Delegation
          </Label>
        )}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="size-3 text-muted-foreground/50 hover:text-muted-foreground cursor-help transition-colors" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[260px]">
              <p className="text-xs leading-relaxed">
                Controls whether the agent is encouraged to spawn sub-agents for parallel work.{' '}
                <strong>Suggest</strong> adds light hints, <strong>Auto</strong> makes the agent a
                full team lead, <strong>Forbid</strong> hides team tools entirely.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <Select value={value} onValueChange={(v) => onValueChange(v as DelegationPolicy)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DELEGATION_POLICY_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <span className="flex items-baseline gap-2">
                <span className="font-medium">{opt.label}</span>
                <span className="text-muted-foreground text-xs">{opt.description}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
