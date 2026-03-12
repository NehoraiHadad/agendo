'use client';

import { useState, useEffect, useCallback } from 'react';

export interface OAuthProvider {
  provider: string;
  label: string;
  method: string;
  type: 'oauth' | 'api-key';
}

export interface AuthStatusResult {
  hasEnvKey: boolean;
  hasCredentialFile: boolean;
  isAuthenticated: boolean;
  method: 'env-var' | 'credential-file' | 'both' | 'none';
  envVarDetails: Array<{ name: string; isSet: boolean }>;
  authCommand: string;
  homepage: string;
  displayName: string;
  /** If set, CLI Login tab shows a provider picker (for multi-provider agents like OpenCode) */
  oauthProviders: OAuthProvider[];
  /** If true, CLI Login tab is not available — agent authenticates on first interactive run */
  noCliAuth: boolean;
}

interface UseAgentAuthReturn {
  status: AuthStatusResult | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAgentAuth(agentId: string): UseAgentAuthReturn {
  const [status, setStatus] = useState<AuthStatusResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/auth-status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AuthStatusResult;
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch auth status');
    } finally {
      setIsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 60_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return { status, isLoading, error, refetch: fetchStatus };
}
