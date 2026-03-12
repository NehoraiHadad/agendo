'use client';

import { useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AuthStatusResult, OAuthProvider } from '@/hooks/use-agent-auth';

type OAuthStep = 'idle' | 'starting' | 'waiting' | 'success' | 'error';

interface AgentAuthModalProps {
  agentId: string;
  agentName: string;
  status: AuthStatusResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthChanged: () => void;
}

export function AgentAuthModal({
  agentId,
  agentName,
  status,
  open,
  onOpenChange,
  onAuthChanged,
}: AgentAuthModalProps) {
  const envVarOptions = status.envVarDetails.map((v) => v.name);

  // API Key flow state
  const [selectedEnvVar, setSelectedEnvVar] = useState<string>(envVarOptions[0] ?? '');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [apiKeySuccess, setApiKeySuccess] = useState(false);

  // OAuth flow state
  const [oauthStep, setOauthStep] = useState<OAuthStep>('idle');
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<OAuthProvider | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const hasProviderPicker = status.oauthProviders.length > 0;

  function resetState() {
    setApiKeyValue('');
    setApiKeyError(null);
    setApiKeySuccess(false);
    setApiKeyLoading(false);
    setOauthStep('idle');
    setOauthUrl(null);
    setOauthError(null);
    setSelectedProvider(null);
    abortRef.current?.abort();
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetState();
    onOpenChange(next);
  }

  async function handleApiKeySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKeyValue.trim() || !selectedEnvVar) return;

    setApiKeyLoading(true);
    setApiKeyError(null);

    try {
      const res = await fetch(`/api/agents/${agentId}/auth-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envVar: selectedEnvVar, value: apiKeyValue.trim() }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      setApiKeySuccess(true);
      onAuthChanged();
      setTimeout(() => handleOpenChange(false), 1500);
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setApiKeyLoading(false);
    }
  }

  async function handleOAuthStart(provider?: OAuthProvider) {
    setOauthStep('starting');
    setOauthUrl(null);
    setOauthError(null);
    if (provider) setSelectedProvider(provider);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const body = provider
        ? JSON.stringify({ provider: provider.provider, method: provider.method })
        : undefined;
      const res = await fetch(`/api/agents/${agentId}/auth-start`, {
        method: 'POST',
        signal: controller.signal,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('No response body');

      setOauthStep('waiting');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;

          const jsonStr = line.slice('data:'.length).trim();
          if (!jsonStr) continue;

          const event = JSON.parse(jsonStr) as {
            type: 'url' | 'success' | 'error';
            url?: string;
            message?: string;
          };

          if (event.type === 'url' && event.url) {
            setOauthUrl(event.url);
          } else if (event.type === 'success') {
            setOauthStep('success');
            onAuthChanged();
            setTimeout(() => handleOpenChange(false), 2000);
            return;
          } else if (event.type === 'error') {
            setOauthStep('error');
            setOauthError(event.message ?? 'Authentication failed');
            return;
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      setOauthStep('error');
      setOauthError(err instanceof Error ? err.message : 'Authentication failed');
    }
  }

  const hasMultipleEnvVars = envVarOptions.length > 1;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {agentName} Authentication</DialogTitle>
          <DialogDescription>
            Set up credentials so Agendo can use {agentName} for your tasks.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="api-key" className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="api-key" className="flex-1">
              API Key
            </TabsTrigger>
            <TabsTrigger value="oauth" className="flex-1">
              CLI Login
            </TabsTrigger>
          </TabsList>

          {/* API Key tab */}
          <TabsContent value="api-key" className="mt-4">
            <form onSubmit={(e) => void handleApiKeySubmit(e)} className="space-y-4">
              {hasMultipleEnvVars ? (
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Environment variable</label>
                  <Select value={selectedEnvVar} onValueChange={setSelectedEnvVar}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select env var" />
                    </SelectTrigger>
                    <SelectContent>
                      {envVarOptions.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Enter your{' '}
                  <code className="font-mono bg-white/10 px-1 rounded">{selectedEnvVar}</code>
                </p>
              )}

              <div className="space-y-1.5">
                {!hasMultipleEnvVars && (
                  <label htmlFor="api-key-input" className="text-xs text-muted-foreground">
                    API Key
                  </label>
                )}
                <Input
                  id="api-key-input"
                  type="password"
                  placeholder="sk-..."
                  value={apiKeyValue}
                  onChange={(e) => setApiKeyValue(e.target.value)}
                  autoComplete="off"
                />
              </div>

              {apiKeyError && <p className="text-xs text-destructive">{apiKeyError}</p>}

              {apiKeySuccess && (
                <p className="text-xs text-emerald-400">API key saved successfully.</p>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={apiKeyLoading || !apiKeyValue.trim() || apiKeySuccess}
              >
                {apiKeyLoading ? 'Saving...' : apiKeySuccess ? 'Saved!' : 'Save API Key'}
              </Button>
            </form>
          </TabsContent>

          {/* OAuth tab */}
          <TabsContent value="oauth" className="mt-4">
            <div className="space-y-4">
              {/* Provider picker for multi-provider agents (e.g. OpenCode) */}
              {oauthStep === 'idle' && hasProviderPicker && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Select a provider:</p>
                  {status.oauthProviders.map((p) => (
                    <Button
                      key={p.provider}
                      variant="outline"
                      className="w-full justify-start text-sm"
                      onClick={() => void handleOAuthStart(p)}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              )}

              {/* Single-provider agents: simple login button */}
              {oauthStep === 'idle' && !hasProviderPicker && (
                <Button className="w-full" onClick={() => void handleOAuthStart()}>
                  Login with {agentName}
                </Button>
              )}

              {oauthStep === 'starting' && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                  Starting authentication{selectedProvider ? ` (${selectedProvider.label})` : ''}...
                </div>
              )}

              {(oauthStep === 'waiting' || oauthStep === 'starting') && oauthUrl && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Open this URL to authenticate:</p>
                  <a
                    href={oauthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block break-all text-xs text-primary underline-offset-2 hover:underline rounded bg-white/[0.04] p-2 border border-white/[0.08]"
                  >
                    {oauthUrl}
                  </a>
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                    Waiting for you to complete login...
                  </p>
                </div>
              )}

              {oauthStep === 'success' && (
                <p className="text-sm text-emerald-400">Successfully authenticated!</p>
              )}

              {oauthStep === 'error' && (
                <div className="space-y-3">
                  <p className="text-sm text-destructive">Authentication failed: {oauthError}</p>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => void handleOAuthStart(selectedProvider ?? undefined)}
                  >
                    Try again
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {/* Fallback terminal command */}
        {status.authCommand && (
          <p className="text-xs text-muted-foreground border-t border-white/[0.06] pt-3">
            Or run in terminal:{' '}
            <code className="font-mono bg-white/10 px-1 rounded">{status.authCommand}</code>
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
