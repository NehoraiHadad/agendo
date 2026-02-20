'use client';

import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, Loader2, Terminal } from 'lucide-react';
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
import { apiFetch, type ApiResponse, type ApiListResponse } from '@/lib/api-types';
import type { Agent, AgentCapability, Execution, JsonSchemaObject } from '@/lib/types';

interface ExecutionTriggerDialogProps {
  taskId: string;
  agentId?: string;
  onExecutionCreated?: (execution: Execution) => void;
  children?: React.ReactNode;
}

export function ExecutionTriggerDialog({
  taskId,
  agentId: agentIdProp,
  onExecutionCreated,
  children,
}: ExecutionTriggerDialogProps) {
  const [open, setOpen] = useState(false);

  // Agent selection (when no agentId prop)
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(agentIdProp ?? '');

  const activeAgentId = agentIdProp ?? selectedAgentId;

  // Capability selection
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

  const fetchAgents = useCallback(async () => {
    if (agentIdProp) return;
    setIsLoadingAgents(true);
    try {
      const res = await apiFetch<ApiListResponse<Agent>>('/api/agents?pageSize=50&group=tools');
      setAgents(res.data.filter((a) => a.isActive));
    } catch {
      // ignore
    } finally {
      setIsLoadingAgents(false);
    }
  }, [agentIdProp]);

  const fetchCapabilities = useCallback(async () => {
    if (!activeAgentId) return;
    setIsLoadingCaps(true);
    setError(null);
    try {
      const res = await apiFetch<ApiResponse<AgentCapability[]>>(
        `/api/agents/${activeAgentId}/capabilities`,
      );
      // Only template-mode capabilities
      const templateCaps = res.data.filter((c) => c.isEnabled && c.interactionMode === 'template');
      setCapabilities(templateCaps);
      if (templateCaps.length === 1) {
        setSelectedCapId(templateCaps[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load capabilities');
    } finally {
      setIsLoadingCaps(false);
    }
  }, [activeAgentId]);

  useEffect(() => {
    if (open) {
      setSelectedAgentId(agentIdProp ?? '');
      setSelectedCapId('');
      setCapabilities([]);
      setArgs({});
      setError(null);
      fetchAgents();
    }
  }, [open, agentIdProp, fetchAgents]);

  useEffect(() => {
    if (open && activeAgentId) {
      setSelectedCapId('');
      setCapabilities([]);
      fetchCapabilities();
    }
  }, [open, activeAgentId, fetchCapabilities]);

  useEffect(() => {
    setArgs({});
  }, [selectedCapId]);

  function handleArgChange(key: string, value: string) {
    setArgs((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCapId || !activeAgentId) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch<ApiResponse<Execution>>('/api/executions', {
        method: 'POST',
        body: JSON.stringify({
          taskId,
          agentId: activeAgentId,
          capabilityId: selectedCapId,
          args,
        }),
      });
      onExecutionCreated?.(res.data);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run command');
    } finally {
      setIsSubmitting(false);
    }
  }

  const isLoading = isLoadingAgents || isLoadingCaps;
  const canSubmit = !!activeAgentId && !!selectedCapId && !isSubmitting && !isLoading;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm" variant="outline">
            <Terminal className="size-4" />
            Run Command
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Run Command</DialogTitle>
          <DialogDescription>Select a command to execute for this task.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {/* Agent selector — shown only when no agentId prop */}
            {!agentIdProp && (
              <div className="space-y-2">
                <Label htmlFor="exec-agent">Tool</Label>
                {isLoadingAgents ? (
                  <Skeleton className="h-9 w-full" />
                ) : (
                  <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                    <SelectTrigger id="exec-agent" className="w-full">
                      <SelectValue placeholder="Select a tool..." />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Capability selector */}
            {activeAgentId && (
              <>
                {isLoadingCaps ? (
                  <Skeleton className="h-9 w-full" />
                ) : capabilities.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                    <p className="font-medium">No commands configured</p>
                    <p className="mt-1 text-xs">
                      Add template capabilities to this agent in{' '}
                      <span className="font-mono">Agent → Capabilities</span>.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="capability">Command</Label>
                    <Select value={selectedCapId} onValueChange={setSelectedCapId}>
                      <SelectTrigger id="capability" className="w-full">
                        <SelectValue placeholder="Select a command..." />
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
                )}

                {selectedCap && selectedCap.dangerLevel >= 2 && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <span>
                      Danger level {selectedCap.dangerLevel}.
                      {selectedCap.dangerLevel >= 3
                        ? ' May perform destructive operations.'
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
          </div>

          {error && <p className="shrink-0 text-sm text-destructive">{error}</p>}

          <DialogFooter className="shrink-0">
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Terminal className="size-4" />
              )}
              Run Command
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
