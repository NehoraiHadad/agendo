'use client';

import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { AgentCapability, Execution, JsonSchemaObject } from '@/lib/types';

interface ExecutionTriggerDialogProps {
  taskId: string;
  agentId: string;
  onExecutionCreated?: (execution: Execution) => void;
  children?: React.ReactNode;
}

export function ExecutionTriggerDialog({
  taskId,
  agentId,
  onExecutionCreated,
  children,
}: ExecutionTriggerDialogProps) {
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [isLoadingCaps, setIsLoadingCaps] = useState(false);
  const [selectedCapId, setSelectedCapId] = useState<string>('');
  const [args, setArgs] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCap = capabilities.find((c) => c.id === selectedCapId);
  const schema = selectedCap?.argsSchema as JsonSchemaObject | undefined;
  const properties = schema?.properties ?? {};
  const requiredFields = schema?.required ?? [];

  const fetchCapabilities = useCallback(async () => {
    setIsLoadingCaps(true);
    setError(null);
    try {
      const res = await apiFetch<ApiResponse<AgentCapability[]>>(
        `/api/agents/${agentId}/capabilities`,
      );
      const enabledCaps = res.data.filter((c) => c.isEnabled);
      setCapabilities(enabledCaps);
      if (enabledCaps.length === 1) {
        setSelectedCapId(enabledCaps[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load capabilities');
    } finally {
      setIsLoadingCaps(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (open) {
      setSelectedCapId('');
      setArgs({});
      setError(null);
      fetchCapabilities();
    }
  }, [open, fetchCapabilities]);

  // Reset args when capability changes
  useEffect(() => {
    setArgs({});
  }, [selectedCapId]);

  function handleArgChange(key: string, value: string) {
    setArgs((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCapId) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch<ApiResponse<Execution>>('/api/executions', {
        method: 'POST',
        body: JSON.stringify({
          taskId,
          agentId,
          capabilityId: selectedCapId,
          args,
        }),
      });
      onExecutionCreated?.(res.data);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create execution');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm">
            <Play className="size-4" />
            Run
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Trigger Execution</DialogTitle>
          <DialogDescription>Select a capability and configure arguments to run.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isLoadingCaps ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="capability">Capability</Label>
                <Select value={selectedCapId} onValueChange={setSelectedCapId}>
                  <SelectTrigger id="capability" className="w-full">
                    <SelectValue placeholder="Select a capability..." />
                  </SelectTrigger>
                  <SelectContent>
                    {capabilities.map((cap) => (
                      <SelectItem key={cap.id} value={cap.id}>
                        {cap.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedCap && selectedCap.dangerLevel >= 2 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-200">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  <span>
                    This capability has danger level {selectedCap.dangerLevel}.
                    {selectedCap.dangerLevel >= 3
                      ? ' It may perform destructive operations.'
                      : ' Proceed with caution.'}
                  </span>
                </div>
              )}

              {selectedCapId && Object.keys(properties).length > 0 && (
                <div className="space-y-3">
                  <Label className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Arguments
                  </Label>
                  {Object.entries(properties).map(([key, schemaProp]) => {
                    const prop = schemaProp as Record<string, string | undefined>;
                    const isRequired = requiredFields.includes(key);
                    const description = prop.description;
                    const defaultValue = prop.default;
                    return (
                      <div key={key} className="space-y-1">
                        <Label htmlFor={`arg-${key}`}>
                          {key}
                          {isRequired && <span className="text-destructive ml-1">*</span>}
                        </Label>
                        {description && (
                          <p className="text-xs text-muted-foreground">{description}</p>
                        )}
                        <Input
                          id={`arg-${key}`}
                          value={args[key] ?? ''}
                          onChange={(e) => handleArgChange(key, e.target.value)}
                          placeholder={
                            defaultValue !== undefined ? String(defaultValue) : undefined
                          }
                          required={isRequired}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={!selectedCapId || isSubmitting || isLoadingCaps}>
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Execute
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
