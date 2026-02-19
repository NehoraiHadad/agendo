'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, MessageSquare, Play } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, type ApiResponse, type ApiListResponse } from '@/lib/api-types';
import type { Agent, AgentCapability, Execution, JsonSchemaObject } from '@/lib/types';
import type { ParsedFlag } from '@/lib/db/schema';

const PRIORITY_FLAGS = [
  '--dangerously-skip-permissions',
  '--permission-mode',
  '--model',
];

const PERMISSION_MODE_VALUES = ['acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'];

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
  const router = useRouter();
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
  const [promptText, setPromptText] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CLI flags
  const [parsedFlags, setParsedFlags] = useState<ParsedFlag[]>([]);
  const [cliFlags, setCliFlags] = useState<Record<string, string | boolean>>({});

  const selectedCap = capabilities.find((c) => c.id === selectedCapId);
  const schema = selectedCap?.argsSchema as JsonSchemaObject | undefined;
  const properties = schema?.properties ?? {};
  const requiredFields = schema?.required ?? [];

  // Fetch agents list when no agentId prop
  const fetchAgents = useCallback(async () => {
    if (agentIdProp) return;
    setIsLoadingAgents(true);
    try {
      const res = await apiFetch<ApiListResponse<Agent>>('/api/agents?pageSize=50');
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
  }, [activeAgentId]);

  const fetchAgentFlags = useCallback(async () => {
    if (!activeAgentId) return;
    try {
      const res = await apiFetch<ApiResponse<Agent>>(`/api/agents/${activeAgentId}`);
      setParsedFlags((res.data.parsedFlags as ParsedFlag[]) ?? []);
    } catch {
      /* ignore */
    }
  }, [activeAgentId]);

  useEffect(() => {
    if (open) {
      setSelectedAgentId(agentIdProp ?? '');
      setSelectedCapId('');
      setCapabilities([]);
      setArgs({});
      setParsedFlags([]);
      setCliFlags({});
      setError(null);
      fetchAgents();
    }
  }, [open, agentIdProp, fetchAgents]);

  useEffect(() => {
    if (open && activeAgentId) {
      setSelectedCapId('');
      setCapabilities([]);
      setCliFlags({});
      fetchCapabilities();
      fetchAgentFlags();
    }
  }, [open, activeAgentId, fetchCapabilities, fetchAgentFlags]);

  useEffect(() => {
    setArgs({});
    setPromptText(selectedCap?.promptTemplate ?? '');
  }, [selectedCapId, selectedCap?.promptTemplate]);

  function handleArgChange(key: string, value: string) {
    setArgs((prev) => ({ ...prev, [key]: value }));
  }

  function handleCliFlagToggle(flag: string, checked: boolean) {
    setCliFlags((prev) => {
      const next = { ...prev };
      if (checked) {
        next[flag] = true;
      } else {
        delete next[flag];
      }
      return next;
    });
  }

  function handleCliFlagValue(flag: string, value: string) {
    setCliFlags((prev) => {
      const next = { ...prev };
      if (value) {
        next[flag] = value;
      } else {
        delete next[flag];
      }
      return next;
    });
  }

  // Separate priority flags from the rest
  const priorityFlags = parsedFlags.filter((pf) =>
    pf.flags.some((f) => PRIORITY_FLAGS.includes(f)),
  );
  const nonPriorityFlags = parsedFlags.filter(
    (pf) => !pf.flags.some((f) => PRIORITY_FLAGS.includes(f)),
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCapId || !activeAgentId) return;

    setIsSubmitting(true);
    setError(null);

    try {
      if (selectedCap?.interactionMode === 'prompt') {
        const res = await apiFetch<ApiResponse<{ id: string }>>('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            taskId,
            agentId: activeAgentId,
            capabilityId: selectedCapId,
            initialPrompt: promptText,
          }),
        });
        setOpen(false);
        router.push(`/sessions/${res.data.id}`);
      } else {
        const res = await apiFetch<ApiResponse<Execution>>('/api/executions', {
          method: 'POST',
          body: JSON.stringify({
            taskId,
            agentId: activeAgentId,
            capabilityId: selectedCapId,
            args,
            cliFlags,
          }),
        });
        onExecutionCreated?.(res.data);
        setOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create execution');
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
          <Button size="sm">
            <Play className="size-4" />
            Run
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {selectedCap?.interactionMode === 'prompt' ? 'Start Session' : 'Trigger Execution'}
          </DialogTitle>
          <DialogDescription>Select an agent, capability and arguments to run.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Agent selector — shown only when no agentId prop */}
          {!agentIdProp && (
            <div className="space-y-2">
              <Label htmlFor="agent">Agent</Label>
              {isLoadingAgents ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                  <SelectTrigger id="agent" className="w-full">
                    <SelectValue placeholder="Select an agent..." />
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
                <div className="space-y-2">
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (
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
              )}

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

              {selectedCapId && selectedCap?.interactionMode === 'prompt' && (
                <div className="space-y-2">
                  <Label htmlFor="initial-prompt">Initial Prompt</Label>
                  <Textarea
                    id="initial-prompt"
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    placeholder="Describe what you want the agent to do..."
                    className="min-h-[120px] resize-y"
                  />
                </div>
              )}

              {selectedCapId && selectedCap?.interactionMode !== 'prompt' && Object.keys(properties).length > 0 && (
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

          {/* CLI Options section — only for template-mode */}
          {selectedCap?.interactionMode !== 'prompt' && parsedFlags.length > 0 && (
            <div className="space-y-3">
              <Label className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                CLI Options
              </Label>
              {priorityFlags.map((pf) => {
                const mainFlag = pf.flags.find((f) => f.startsWith('--')) ?? pf.flags[0];
                const isPermissionMode = mainFlag === '--permission-mode';
                const isModel = mainFlag === '--model';

                if (isPermissionMode) {
                  return (
                    <div key={mainFlag} className="space-y-1">
                      <label className="text-sm font-medium">{mainFlag}</label>
                      <p className="text-xs text-muted-foreground">{pf.description}</p>
                      <Select
                        value={(cliFlags[mainFlag] as string) ?? ''}
                        onValueChange={(val) => handleCliFlagValue(mainFlag, val)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Default" />
                        </SelectTrigger>
                        <SelectContent>
                          {PERMISSION_MODE_VALUES.map((v) => (
                            <SelectItem key={v} value={v}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                }

                if (isModel || pf.takesValue) {
                  return (
                    <div key={mainFlag} className="space-y-1">
                      <label className="text-sm font-medium">{mainFlag}</label>
                      <p className="text-xs text-muted-foreground">{pf.description}</p>
                      <Input
                        value={(cliFlags[mainFlag] as string) ?? ''}
                        onChange={(e) => handleCliFlagValue(mainFlag, e.target.value)}
                        placeholder={pf.valueHint ?? undefined}
                      />
                    </div>
                  );
                }

                // Boolean flag (checkbox)
                return (
                  <div key={mainFlag} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      id={`cli-${mainFlag}`}
                      checked={cliFlags[mainFlag] === true}
                      onChange={(e) => handleCliFlagToggle(mainFlag, e.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-border"
                    />
                    <div>
                      <label htmlFor={`cli-${mainFlag}`} className="text-sm font-medium cursor-pointer">
                        {mainFlag}
                      </label>
                      <p className="text-xs text-muted-foreground">{pf.description}</p>
                    </div>
                  </div>
                );
              })}

              {nonPriorityFlags.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Advanced options ({nonPriorityFlags.length})
                  </summary>
                  <div className="mt-2 space-y-2">
                    {nonPriorityFlags.map((pf) => {
                      const mainFlag = pf.flags.find((f) => f.startsWith('--')) ?? pf.flags[0];

                      if (pf.takesValue) {
                        return (
                          <div key={mainFlag} className="space-y-1">
                            <label className="text-sm font-medium">{mainFlag}</label>
                            <p className="text-xs text-muted-foreground">{pf.description}</p>
                            <Input
                              value={(cliFlags[mainFlag] as string) ?? ''}
                              onChange={(e) => handleCliFlagValue(mainFlag, e.target.value)}
                              placeholder={pf.valueHint ?? undefined}
                            />
                          </div>
                        );
                      }

                      return (
                        <div key={mainFlag} className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            id={`cli-${mainFlag}`}
                            checked={cliFlags[mainFlag] === true}
                            onChange={(e) => handleCliFlagToggle(mainFlag, e.target.checked)}
                            className="mt-1 h-4 w-4 rounded border-border"
                          />
                          <div>
                            <label htmlFor={`cli-${mainFlag}`} className="text-sm font-medium cursor-pointer">
                              {mainFlag}
                            </label>
                            <p className="text-xs text-muted-foreground">{pf.description}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : selectedCap?.interactionMode === 'prompt' ? (
                <MessageSquare className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
              {selectedCap?.interactionMode === 'prompt' ? 'Start Session' : 'Execute'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
