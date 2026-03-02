'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ShieldCheck, Shield, ShieldAlert, ShieldBan } from 'lucide-react';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { AgentCapability } from '@/lib/types';

interface CapabilityRowProps {
  capability: AgentCapability;
  onToggle?: (id: string, isEnabled: boolean) => void;
  onDelete?: (id: string) => void;
}

const DANGER_ICONS = [
  { Icon: ShieldCheck, className: 'text-green-600' },
  { Icon: Shield, className: 'text-yellow-600' },
  { Icon: ShieldAlert, className: 'text-orange-600' },
  { Icon: ShieldBan, className: 'text-red-600' },
] as const;

export function CapabilityRow({ capability, onToggle, onDelete }: CapabilityRowProps) {
  const [isEnabled, setIsEnabled] = useState(capability.isEnabled);
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const dangerIndex = Math.min(capability.dangerLevel, 3);
  const { Icon: DangerIcon, className: dangerClassName } = DANGER_ICONS[dangerIndex];

  async function handleToggleEnabled(checked: boolean) {
    setIsTogglingEnabled(true);
    const prev = isEnabled;
    setIsEnabled(checked);
    try {
      await apiFetch<ApiResponse<AgentCapability>>(
        `/api/agents/${capability.agentId}/capabilities/${capability.id}`,
        { method: 'PATCH', body: JSON.stringify({ isEnabled: checked }) },
      );
      onToggle?.(capability.id, checked);
    } catch {
      setIsEnabled(prev); // revert on error
    } finally {
      setIsTogglingEnabled(false);
    }
  }

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await apiFetch<ApiResponse<{ success: boolean }>>(
        `/api/agents/${capability.agentId}/capabilities/${capability.id}`,
        { method: 'DELETE' },
      );
      onDelete?.(capability.id);
    } catch {
      setIsDeleting(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
      <div className="flex items-center gap-3 min-w-0">
        <DangerIcon className={`h-4 w-4 shrink-0 ${dangerClassName}`} />
        <div className="min-w-0">
          <span className="text-sm font-medium">{capability.label}</span>
          {capability.description && (
            <p className="text-xs text-muted-foreground truncate max-w-md">
              {capability.description}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {(onToggle !== undefined || onDelete !== undefined) && (
          <Switch
            checked={isEnabled}
            onCheckedChange={handleToggleEnabled}
            disabled={isTogglingEnabled}
            aria-label={isEnabled ? 'Disable capability' : 'Enable capability'}
          />
        )}
        {onDelete && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={handleDelete}
            disabled={isDeleting}
            aria-label="Delete capability"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
