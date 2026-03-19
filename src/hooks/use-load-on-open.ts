'use client';

import { useFetch } from '@/hooks/use-fetch';

/**
 * Fetches data when a dialog/panel is open. Skips the fetch when closed.
 *
 * Usage:
 *   const { data, isLoading } = useLoadOnOpen(open ? '/api/agents' : null);
 *
 * Or with transform:
 *   const { data } = useLoadOnOpen<Agent[]>(open ? '/api/agents' : null, {
 *     transform: (r) => (r as { data: Agent[] }).data,
 *   });
 */
export function useLoadOnOpen<T>(
  url: string | null,
  options?: {
    enabled?: boolean;
    transform?: (response: unknown) => T;
  },
): {
  data: T | undefined;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const enabled = options?.enabled ?? true;
  const effectiveUrl = enabled ? url : null;

  const defaultTransform = (response: unknown): T => (response as { data: T }).data;

  const { data, isLoading, error, refetch } = useFetch<T>(effectiveUrl, {
    transform: options?.transform ?? defaultTransform,
  });

  return {
    data: data ?? undefined,
    isLoading,
    error,
    refetch,
  };
}
