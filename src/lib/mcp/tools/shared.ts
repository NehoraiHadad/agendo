/**
 * Shared utilities for agendo MCP tool modules.
 *
 * IMPORTANT: No `@/` path aliases — this directory is bundled with esbuild.
 * All imports must use relative paths.
 */

export const AGENDO_URL = process.env.AGENDO_URL ?? 'http://localhost:4100';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ApiCallOptions {
  method?: string;
  body?: unknown;
}

export async function apiCall(path: string, options: ApiCallOptions = {}): Promise<unknown> {
  const url = `${AGENDO_URL}${path}`;
  const { method = 'GET', body } = options;

  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const json = (await res.json()) as {
    data?: unknown;
    error?: { message?: string };
  };

  if (!res.ok) {
    const errMsg = json.error?.message ?? `API error ${res.status}: ${res.statusText}`;
    throw new Error(errMsg);
  }

  return json.data;
}

// ---------------------------------------------------------------------------
// Agent slug resolution
// ---------------------------------------------------------------------------

export async function resolveAgentSlug(slug: string): Promise<string> {
  const data = (await apiCall(`/api/agents?slug=${encodeURIComponent(slug)}`)) as
    | Array<{ id: string }>
    | undefined;

  if (!data || data.length === 0) {
    throw new Error(`Agent not found: ${slug}`);
  }

  return data[0].id;
}

// ---------------------------------------------------------------------------
// Priority parsing
// ---------------------------------------------------------------------------

const PRIORITY_MAP: Record<string, number> = {
  lowest: 1,
  low: 2,
  medium: 3,
  high: 4,
  highest: 5,
  critical: 5,
};

export function parsePriority(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const num = parseInt(value, 10);
  if (!isNaN(num)) return num;
  return PRIORITY_MAP[value.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Tool result wrapper — eliminates try/catch boilerplate across all handlers
// ---------------------------------------------------------------------------

export async function wrapToolCall(fn: () => Promise<unknown>): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  try {
    const result = await fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}
