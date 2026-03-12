/**
 * Shared utilities for agendo MCP tool modules.
 *
 * IMPORTANT: No `@/` path aliases — this directory is bundled with esbuild.
 * All imports must use relative paths.
 */

export const AGENDO_URL = process.env.AGENDO_URL ?? 'http://localhost:4100';

/** Event type constant for agent progress notes. */
export const AGENT_NOTE = 'agent_note';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ApiCallOptions {
  method?: string;
  body?: unknown;
}

async function fetchJson(
  path: string,
  options: ApiCallOptions = {},
): Promise<{
  data?: unknown;
  meta?: unknown;
  error?: { message?: string };
  ok: boolean;
  status: number;
  statusText: string;
}> {
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
  const contentType = res.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(
      `API error ${res.status}: expected JSON but got ${contentType || 'unknown content-type'}. Body: ${text.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as {
    data?: unknown;
    meta?: unknown;
    error?: { message?: string };
  };

  return { ...json, ok: res.ok, status: res.status, statusText: res.statusText };
}

export async function apiCall(path: string, options: ApiCallOptions = {}): Promise<unknown> {
  const json = await fetchJson(path, options);
  if (!json.ok) {
    const errMsg = json.error?.message ?? `API error ${json.status}: ${json.statusText}`;
    throw new Error(errMsg);
  }
  return json.data;
}

/** Like apiCall but also returns the `meta` field (e.g. pagination cursors). */
export async function apiCallWithMeta(
  path: string,
  options: ApiCallOptions = {},
): Promise<{ data: unknown; meta: unknown }> {
  const json = await fetchJson(path, options);
  if (!json.ok) {
    const errMsg = json.error?.message ?? `API error ${json.status}: ${json.statusText}`;
    throw new Error(errMsg);
  }
  return { data: json.data, meta: json.meta };
}

// ---------------------------------------------------------------------------
// Task ID resolution
// ---------------------------------------------------------------------------

/** Resolves taskId from an explicit arg or falls back to AGENDO_TASK_ID env var. Throws if neither is set. */
export function resolveTaskId(taskIdArg: string | undefined): string {
  const taskId = taskIdArg ?? process.env.AGENDO_TASK_ID;
  if (!taskId) {
    throw new Error('No taskId provided and AGENDO_TASK_ID not set');
  }
  return taskId;
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
