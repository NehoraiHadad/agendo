'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle, XCircle, Key, FileKey, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EnvVarDetail {
  name: string;
  isSet: boolean;
}

interface ProviderStatus {
  binaryName: string;
  displayName: string;
  isAuthenticated: boolean;
  method: 'env-var' | 'credential-file' | 'both' | 'none';
  envVarDetails: EnvVarDetail[];
  authCommand: string;
  homepage: string;
  hasEnvKey: boolean;
  hasCredentialFile: boolean;
}

const PROVIDER_COLORS: Record<string, string> = {
  claude: 'oklch(0.7 0.18 280)',
  codex: 'oklch(0.65 0.15 140)',
  gemini: 'oklch(0.7 0.15 55)',
  copilot: 'oklch(0.6 0.12 225)',
};

function methodLabel(method: string): string {
  switch (method) {
    case 'env-var':
      return 'API Key';
    case 'credential-file':
      return 'CLI Login';
    case 'both':
      return 'API Key + CLI';
    default:
      return 'Not configured';
  }
}

function MethodIcon({ method }: { method: string }) {
  if (method === 'env-var' || method === 'both') return <Key className="h-3 w-3" />;
  if (method === 'credential-file') return <FileKey className="h-3 w-3" />;
  return <XCircle className="h-3 w-3" />;
}

function ProviderCard({ provider }: { provider: ProviderStatus }) {
  const color = PROVIDER_COLORS[provider.binaryName] ?? 'oklch(0.5 0.05 260)';

  return (
    <div
      className="rounded-lg border border-white/[0.06] overflow-hidden"
      style={{ background: 'oklch(0.09 0 0)' }}
    >
      {/* Color accent bar */}
      <div className="h-[2px] w-full" style={{ background: color }} />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <span
              className="font-mono text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ color, background: `${color}18` }}
            >
              {provider.binaryName}
            </span>
            <span className="text-[13px] font-medium text-foreground/80">
              {provider.displayName}
            </span>
          </div>
          {provider.isAuthenticated ? (
            <div className="flex items-center gap-1.5">
              <CheckCircle className="h-3.5 w-3.5" style={{ color: 'oklch(0.65 0.15 140)' }} />
              <span className="text-[11px] font-medium" style={{ color: 'oklch(0.65 0.15 140)' }}>
                Connected
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-muted-foreground/30" />
              <span className="text-[11px] font-medium text-muted-foreground/40">
                Not connected
              </span>
            </div>
          )}
        </div>

        {/* Method */}
        <div className="flex items-center gap-2 mb-3">
          <MethodIcon method={provider.method} />
          <span className="text-[12px] text-muted-foreground/60">
            {methodLabel(provider.method)}
          </span>
        </div>

        {/* Env var details */}
        <div className="space-y-1.5 mb-3">
          {provider.envVarDetails.map((v) => (
            <div key={v.name} className="flex items-center gap-2">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  v.isSet ? 'bg-emerald-400/60' : 'bg-white/[0.08]',
                )}
              />
              <code className="text-[11px] font-mono text-muted-foreground/50">{v.name}</code>
              <span
                className={cn(
                  'text-[10px]',
                  v.isSet ? 'text-emerald-400/60' : 'text-muted-foreground/25',
                )}
              >
                {v.isSet ? 'set' : 'not set'}
              </span>
            </div>
          ))}
        </div>

        {/* Credential file status */}
        <div className="flex items-center gap-2 mb-3">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full shrink-0',
              provider.hasCredentialFile ? 'bg-emerald-400/60' : 'bg-white/[0.08]',
            )}
          />
          <span className="text-[11px] text-muted-foreground/50">CLI credential file</span>
          <span
            className={cn(
              'text-[10px]',
              provider.hasCredentialFile ? 'text-emerald-400/60' : 'text-muted-foreground/25',
            )}
          >
            {provider.hasCredentialFile ? 'found' : 'not found'}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2 border-t border-white/[0.04]">
          {!provider.isAuthenticated && provider.authCommand && (
            <code className="text-[10px] font-mono text-muted-foreground/35 flex-1 truncate">
              $ {provider.authCommand}
            </code>
          )}
          <a
            href={provider.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-foreground/60 transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            Docs
          </a>
        </div>
      </div>
    </div>
  );
}

export function ProviderStatusTab() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/providers');
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'Failed to fetch provider status');
        return;
      }
      const body = (await res.json()) as { data: ProviderStatus[] };
      setProviders(body.data);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <p className="text-sm text-muted-foreground/60">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  const authenticated = providers.filter((p) => p.isAuthenticated);
  const total = providers.length;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-muted-foreground/50">
            {authenticated.length}/{total} providers connected
          </span>
          <div className="flex gap-1">
            {providers.map((p) => (
              <span
                key={p.binaryName}
                className={cn(
                  'h-2 w-2 rounded-full',
                  p.isAuthenticated ? 'bg-emerald-400/60' : 'bg-white/[0.08]',
                )}
                title={`${p.displayName}: ${p.isAuthenticated ? 'connected' : 'not connected'}`}
              />
            ))}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading}
          className="h-7 text-[12px]"
        >
          <RefreshCw className={cn('h-3 w-3 mr-1.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Provider cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {providers.map((provider) => (
          <ProviderCard key={provider.binaryName} provider={provider} />
        ))}
      </div>
    </div>
  );
}
