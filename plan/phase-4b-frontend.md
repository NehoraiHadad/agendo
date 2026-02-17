# Phase 4b: Execution Engine — Frontend

> **Goal**: Execution trigger UI, live log streaming viewer, bidirectional message input, session resume, and interactive web terminal via xterm.js.
> **Depends on**: Phase 4a (backend: executions table, worker, adapters, SSE endpoint, terminal server, API routes)
> **New packages**: `ansi-to-html isomorphic-dompurify @xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-search @xterm/addon-webgl socket.io-client`

---

## Prerequisites (Must Exist from Phase 1-4a)

Before starting Phase 4b, verify these files exist and are functional:

| File | Purpose | Phase |
|------|---------|-------|
| `src/lib/db/schema.ts` | All tables including `executions` (log fields merged onto executions table) | 1 / 4a |
| `src/lib/types.ts` | Drizzle inferred types: `Execution`, `ExecutionStatus` | 1 / 4a |
| `src/lib/api-handler.ts` | `withErrorBoundary` wrapper for API routes | 1 |
| `src/lib/api-types.ts` | Response envelope types + `apiFetch` | 1 |
| `src/lib/state-machines.ts` | Execution status transitions | 4a |
| `src/lib/services/execution-service.ts` | `createExecution`, `listExecutions`, `getExecution`, `cancelExecution` | 4a |
| `src/lib/services/capability-service.ts` | `listCapabilities`, `getCapabilityById` | 2 |
| `src/app/api/executions/route.ts` | `GET` (list), `POST` (create) | 4a |
| `src/app/api/executions/[id]/route.ts` | `GET` (detail) | 4a |
| `src/app/api/executions/[id]/cancel/route.ts` | `POST` (cancel) | 4a |
| `src/app/api/executions/[id]/logs/route.ts` | `GET` (full log dump) | 4a |
| `src/app/api/executions/[id]/logs/stream/route.ts` | `GET` (SSE stream) | 4a |
| `src/app/api/executions/[id]/message/route.ts` | `POST` (send message) | 4a |
| `src/app/api/terminal/token/route.ts` | `POST` (JWT for terminal WS) | 4a |
| `src/components/ui/*` | shadcn: Sheet, Badge, Dialog, Button, Table, Tooltip, ScrollArea, Select, Input, Separator | 1 |
| `src/components/layout/app-shell.tsx` | Sidebar + main content area | 1 |
| Terminal server running on `:4101` | WebSocket + node-pty + tmux | 4a |

---

## Packages to Install

```bash
cd /home/ubuntu/projects/agent-monitor
pnpm add ansi-to-html isomorphic-dompurify socket.io-client
pnpm add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-search @xterm/addon-webgl
# Note: @types/dompurify is NOT needed — isomorphic-dompurify ships its own types
```

- `ansi-to-html` — converts ANSI escape sequences to styled HTML `<span>` elements
- `isomorphic-dompurify` — sanitizes HTML output to prevent XSS (works in both Node and browser)
- `socket.io-client` — WebSocket client for terminal server communication
- `@xterm/*` — terminal emulator for interactive web terminal (v6, scoped packages)

---

## SSE Event Types (Shared with Backend)

These types are defined in Phase 4a and consumed by the frontend hooks.

**File**: `src/lib/types.ts` (append to existing)

```typescript
// --- SSE Log Event Types (discriminated union) ---

export type SseLogEvent =
  | { type: 'status';  status: ExecutionStatus }
  | { type: 'catchup'; content: string }
  | { type: 'log';     content: string; stream: 'stdout' | 'stderr' | 'system' }
  | { type: 'done';    status: ExecutionStatus; exitCode: number | null }
  | { type: 'error';   message: string };
```

These are already defined in `src/lib/types.ts` by Phase 4a. The frontend simply imports them.

---

## Steps

### Step 1: ANSI-to-HTML Log Renderer

**File**: `src/lib/log-renderer.ts`
**Purpose**: Convert raw ANSI-escaped log output into sanitized HTML for display in the log viewer. Uses `ansi-to-html` for ANSI conversion and `isomorphic-dompurify` for XSS prevention.
**Depends on**: None (utility module)

```typescript
// src/lib/log-renderer.ts

import AnsiToHtml from 'ansi-to-html';
import DOMPurify from 'isomorphic-dompurify';

// Singleton converter — reuse to avoid re-creating on every line
const ansiConverter = new AnsiToHtml({
  fg: '#a9b1d6',     // default text color (zinc-300 equivalent)
  bg: 'transparent',  // no background override
  newline: false,     // we handle newlines ourselves
  escapeXML: true,    // escape HTML entities before ANSI parsing
  colors: {
    // 256-color overrides to match our terminal theme
    0: '#15161E',   // black
    1: '#f7768e',   // red
    2: '#9ece6a',   // green
    3: '#e0af68',   // yellow
    4: '#7aa2f7',   // blue
    5: '#bb9af7',   // magenta
    6: '#7dcfff',   // cyan
    7: '#a9b1d6',   // white
  },
});

// DOMPurify config — only allow <span> with inline styles (from ANSI conversion)
const PURIFY_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: ['span'],
  ALLOWED_ATTR: ['style'],
};

/**
 * Render a single log line from raw ANSI text to sanitized HTML.
 * All output is sanitized via DOMPurify (ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['style']).
 *
 * @param raw - Raw log line potentially containing ANSI escape codes
 * @returns Sanitized HTML string safe for rendering
 */
export function renderLogLine(raw: string): string {
  const html = ansiConverter.toHtml(raw);
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/**
 * Render a multiline log chunk (e.g., catchup content) into an array of
 * sanitized HTML lines.
 *
 * @param raw - Raw log content, may contain newlines
 * @returns Array of sanitized HTML strings, one per line
 */
export function renderLogChunk(raw: string): string[] {
  return raw.split('\n').map(renderLogLine);
}

/**
 * Stream classification — determines the Tailwind text color class for a log
 * line based on its source stream.
 */
export function getStreamColorClass(
  stream: 'stdout' | 'stderr' | 'system' | 'user'
): string {
  switch (stream) {
    case 'stdout':  return 'text-zinc-100';
    case 'stderr':  return 'text-amber-400';
    case 'system':  return 'text-blue-400';
    case 'user':    return 'text-green-400';
  }
}
```

**Key decisions**:
- `escapeXML: true` on the converter ensures raw `<script>` tags in log output are escaped before ANSI processing, then DOMPurify strips anything that still looks like HTML.
- Only `<span style="...">` is allowed through DOMPurify — all other elements and attributes are stripped.
- Color classes are Tailwind utilities applied to the outer wrapper; ANSI colors are inline styles on inner `<span>` elements.

---

### Step 2: SSE Log Stream Hook

**File**: `src/lib/hooks/use-execution-log-stream.ts`
**Purpose**: React hook that subscribes to the SSE log stream endpoint, manages reconnection with exponential backoff, appends log lines to state, and detects execution completion.
**Depends on**: Step 1 (log-renderer), Phase 4a SSE endpoint

```typescript
// src/lib/hooks/use-execution-log-stream.ts
'use client';

import { useEffect, useRef, useCallback, useReducer } from 'react';
import { renderLogLine, renderLogChunk, getStreamColorClass } from '@/lib/log-renderer';
import type { SseLogEvent, ExecutionStatus } from '@/lib/types';

// --- Types ---

export interface LogLine {
  id: number;       // monotonic counter for React key
  html: string;     // sanitized HTML content
  stream: 'stdout' | 'stderr' | 'system' | 'user';
  colorClass: string;
  timestamp: number; // Date.now() when received
}

interface LogStreamState {
  lines: LogLine[];
  status: ExecutionStatus | null;
  exitCode: number | null;
  isConnected: boolean;
  isDone: boolean;
  error: string | null;
}

type LogStreamAction =
  | { type: 'APPEND_LINES'; lines: LogLine[] }
  | { type: 'SET_STATUS'; status: ExecutionStatus }
  | { type: 'SET_DONE'; status: ExecutionStatus; exitCode: number | null }
  | { type: 'SET_CONNECTED'; connected: boolean }
  | { type: 'SET_ERROR'; message: string }
  | { type: 'RESET' };

// --- Constants ---

const MAX_VISIBLE_LINES = 5000;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
const RETRY_BACKOFF = 2;

// --- Reducer ---

let lineIdCounter = 0;

function logStreamReducer(
  state: LogStreamState,
  action: LogStreamAction
): LogStreamState {
  switch (action.type) {
    case 'APPEND_LINES': {
      const combined = [...state.lines, ...action.lines];
      // Sliding window: keep only the last MAX_VISIBLE_LINES
      const lines =
        combined.length > MAX_VISIBLE_LINES
          ? combined.slice(combined.length - MAX_VISIBLE_LINES)
          : combined;
      return { ...state, lines };
    }
    case 'SET_STATUS':
      return { ...state, status: action.status };
    case 'SET_DONE':
      return {
        ...state,
        status: action.status,
        exitCode: action.exitCode,
        isDone: true,
        isConnected: false,
      };
    case 'SET_CONNECTED':
      return { ...state, isConnected: action.connected, error: null };
    case 'SET_ERROR':
      return { ...state, error: action.message, isConnected: false };
    case 'RESET':
      return initialState();
    default:
      return state;
  }
}

function initialState(): LogStreamState {
  return {
    lines: [],
    status: null,
    exitCode: null,
    isConnected: false,
    isDone: false,
    error: null,
  };
}

// --- Hook ---

export interface UseExecutionLogStreamOptions {
  executionId: string;
  enabled?: boolean; // default true
}

export function useExecutionLogStream({
  executionId,
  enabled = true,
}: UseExecutionLogStreamOptions) {
  const [state, dispatch] = useReducer(logStreamReducer, undefined, initialState);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(INITIAL_RETRY_MS);
  const eventSourceRef = useRef<EventSource | null>(null);

  const createLogLine = useCallback(
    (html: string, stream: 'stdout' | 'stderr' | 'system' | 'user'): LogLine => ({
      id: ++lineIdCounter,
      html,
      stream,
      colorClass: getStreamColorClass(stream),
      timestamp: Date.now(),
    }),
    []
  );

  const connect = useCallback(() => {
    if (!enabled || !executionId) return;

    // Clean up any existing connection
    eventSourceRef.current?.close();

    const url = `/api/executions/${executionId}/logs/stream`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      dispatch({ type: 'SET_CONNECTED', connected: true });
      retryDelayRef.current = INITIAL_RETRY_MS; // reset backoff on success
    };

    es.onmessage = (event) => {
      try {
        const data: SseLogEvent = JSON.parse(event.data);

        switch (data.type) {
          case 'catchup': {
            // Bulk load existing log content
            const htmlLines = renderLogChunk(data.content);
            const logLines = htmlLines.map((html) =>
              createLogLine(html, 'stdout')
            );
            dispatch({ type: 'APPEND_LINES', lines: logLines });
            break;
          }
          case 'log': {
            const html = renderLogLine(data.content);
            const line = createLogLine(html, data.stream);
            dispatch({ type: 'APPEND_LINES', lines: [line] });
            break;
          }
          case 'status': {
            dispatch({ type: 'SET_STATUS', status: data.status });
            break;
          }
          case 'done': {
            dispatch({
              type: 'SET_DONE',
              status: data.status,
              exitCode: data.exitCode,
            });
            es.close();
            break;
          }
          case 'error': {
            dispatch({ type: 'SET_ERROR', message: data.message });
            es.close();
            break;
          }
        }
      } catch {
        // Ignore malformed events
      }
    };

    es.onerror = () => {
      es.close();
      dispatch({ type: 'SET_CONNECTED', connected: false });

      // Don't retry if already done
      if (state.isDone) return;

      // Exponential backoff reconnect
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * RETRY_BACKOFF, MAX_RETRY_MS);

      retryTimeoutRef.current = setTimeout(connect, delay);
    };
  }, [executionId, enabled, createLogLine, state.isDone]);

  useEffect(() => {
    dispatch({ type: 'RESET' });
    lineIdCounter = 0;
    connect();

    return () => {
      eventSourceRef.current?.close();
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, [connect]);

  return {
    lines: state.lines,
    status: state.status,
    exitCode: state.exitCode,
    isConnected: state.isConnected,
    isDone: state.isDone,
    error: state.error,
    lineCount: state.lines.length,
    isTruncated: state.lines.length >= MAX_VISIBLE_LINES,
  };
}
```

**Key decisions**:
- **useReducer** instead of multiple useState calls — keeps state updates atomic and avoids stale closure issues.
- **Sliding window**: When lines exceed `MAX_VISIBLE_LINES` (5000), older lines are dropped from the front. A `isTruncated` flag is exposed so the viewer can show a truncation banner.
- **Exponential backoff**: Starts at 1s, doubles each retry, caps at 30s. Resets on successful connection.
- **Line IDs**: Monotonic counter for stable React keys. Not using array index because lines shift when the sliding window truncates.
- **Completion detection**: The `done` SSE event closes the EventSource permanently. No reconnection attempt after `done`.

---

### Step 3: Execution Status Badge

**File**: `src/components/executions/execution-status-badge.tsx`
**Purpose**: Reusable badge component that renders execution status with appropriate color coding.
**Depends on**: shadcn Badge

```typescript
// src/components/executions/execution-status-badge.tsx

import { Badge } from '@/components/ui/badge';
import type { ExecutionStatus } from '@/lib/types';

const STATUS_CONFIG: Record<
  ExecutionStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  queued:      { label: 'Queued',      variant: 'outline' },
  running:     { label: 'Running',     variant: 'default' },
  cancelling:  { label: 'Cancelling',  variant: 'secondary' },
  succeeded:   { label: 'Succeeded',   variant: 'secondary' },
  failed:      { label: 'Failed',      variant: 'destructive' },
  cancelled:   { label: 'Cancelled',   variant: 'outline' },
  timed_out:   { label: 'Timed Out',   variant: 'destructive' },
};

interface ExecutionStatusBadgeProps {
  status: ExecutionStatus;
  className?: string;
}

export function ExecutionStatusBadge({
  status,
  className,
}: ExecutionStatusBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <Badge variant={config.variant} className={className}>
      {status === 'running' && (
        <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
      )}
      {config.label}
    </Badge>
  );
}
```

---

### Step 4: Execution Cancel Button

**File**: `src/components/executions/execution-cancel-button.tsx`
**Purpose**: Client component that sends a cancel request for a running execution with confirmation.
**Depends on**: Phase 4a cancel API route

```typescript
// src/components/executions/execution-cancel-button.tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { XCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-types';
import type { ExecutionStatus } from '@/lib/types';

interface ExecutionCancelButtonProps {
  executionId: string;
  status: ExecutionStatus;
  onCancelled?: () => void;
}

export function ExecutionCancelButton({
  executionId,
  status,
  onCancelled,
}: ExecutionCancelButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  // Only show for cancellable statuses
  const isCancellable = status === 'running' || status === 'queued';
  if (!isCancellable) return null;

  async function handleCancel() {
    if (!confirm('Cancel this execution? This will send SIGTERM to the process.')) {
      return;
    }

    setIsLoading(true);
    try {
      await apiFetch(`/api/executions/${executionId}/cancel`, {
        method: 'POST',
      });
      onCancelled?.();
    } catch (err) {
      console.error('Failed to cancel execution:', err);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Button
      variant="destructive"
      size="sm"
      onClick={handleCancel}
      disabled={isLoading}
    >
      {isLoading ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <XCircle className="mr-1.5 h-3.5 w-3.5" />
      )}
      Cancel
    </Button>
  );
}
```

---

### Step 5: Execution Trigger Dialog

**File**: `src/components/executions/execution-trigger-dialog.tsx`
**Purpose**: Modal dialog that lets the user select a capability and provide arguments to trigger a new execution. Shows danger warnings for capabilities with `level >= 2`.
**Depends on**: Phase 2 (capability-service), Phase 4a (execution creation API)

```typescript
// src/components/executions/execution-trigger-dialog.tsx
'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, Play, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-types';
import type { AgentCapability, Execution } from '@/lib/types';

interface ExecutionTriggerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  agentId: string;
  onExecutionCreated: (execution: Execution) => void;
}

interface CapabilityArg {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  default?: string;
}

export function ExecutionTriggerDialog({
  open,
  onOpenChange,
  taskId,
  agentId,
  onExecutionCreated,
}: ExecutionTriggerDialogProps) {
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [selectedCapId, setSelectedCapId] = useState<string>('');
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch capabilities for this agent
  useEffect(() => {
    if (!open || !agentId) return;

    apiFetch<AgentCapability[]>(`/api/agents/${agentId}/capabilities`)
      .then((res) => {
        setCapabilities(res.data ?? []);
        setSelectedCapId('');
        setArgValues({});
        setError(null);
      })
      .catch(() => setError('Failed to load capabilities'));
  }, [open, agentId]);

  const selectedCapability = capabilities.find((c) => c.id === selectedCapId);
  const capabilityArgs: CapabilityArg[] = selectedCapability?.argsSchema?.properties
    ? Object.entries(selectedCapability.argsSchema.properties).map(
        ([name, schema]: [string, any]) => ({
          name,
          type: schema.type ?? 'string',
          required: selectedCapability.argsSchema?.required?.includes(name) ?? false,
          description: schema.description,
          default: schema.default,
        })
      )
    : [];
  const isDangerous = (selectedCapability?.dangerLevel ?? 0) >= 2;

  function handleArgChange(name: string, value: string) {
    setArgValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit() {
    if (!selectedCapId) return;

    // Validate required args
    for (const arg of capabilityArgs) {
      if (arg.required && !argValues[arg.name]?.trim()) {
        setError(`Required argument "${arg.name}" is missing`);
        return;
      }
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch<Execution>('/api/executions', {
        method: 'POST',
        body: JSON.stringify({
          taskId,
          agentId,
          capabilityId: selectedCapId,
          args: argValues,
        }),
      });

      if (res.data) {
        onExecutionCreated(res.data);
        onOpenChange(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create execution');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Run Execution</DialogTitle>
          <DialogDescription>
            Select a capability and provide arguments to start an execution.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Capability selector */}
          <div className="space-y-2">
            <Label htmlFor="capability">Capability</Label>
            <Select value={selectedCapId} onValueChange={setSelectedCapId}>
              <SelectTrigger id="capability">
                <SelectValue placeholder="Select a capability..." />
              </SelectTrigger>
              <SelectContent>
                {capabilities.map((cap) => (
                  <SelectItem key={cap.id} value={cap.id}>
                    <span className="flex items-center gap-2">
                      {cap.label}
                      {(cap.dangerLevel ?? 0) >= 2 && (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Danger warning for high-level capabilities */}
          {isDangerous && (
            <div className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <div className="text-sm">
                <p className="font-medium text-amber-500">Elevated Capability</p>
                <p className="text-muted-foreground">
                  This capability has danger level {selectedCapability?.dangerLevel} permissions.
                  It may modify files, run commands, or make external requests.
                  Proceed with caution.
                </p>
              </div>
            </div>
          )}

          {/* Dynamic args form */}
          {capabilityArgs.length > 0 && (
            <div className="space-y-3">
              <Label className="text-sm font-medium">Arguments</Label>
              {capabilityArgs.map((arg) => (
                <div key={arg.name} className="space-y-1.5">
                  <Label htmlFor={`arg-${arg.name}`} className="text-xs">
                    {arg.name}
                    {arg.required && <span className="text-destructive ml-0.5">*</span>}
                  </Label>
                  {arg.type === 'string' && (arg.description?.includes('multiline') || arg.name === 'prompt') ? (
                    <Textarea
                      id={`arg-${arg.name}`}
                      value={argValues[arg.name] ?? arg.default ?? ''}
                      onChange={(e) => handleArgChange(arg.name, e.target.value)}
                      placeholder={arg.description}
                      rows={3}
                    />
                  ) : (
                    <Input
                      id={`arg-${arg.name}`}
                      value={argValues[arg.name] ?? arg.default ?? ''}
                      onChange={(e) => handleArgChange(arg.name, e.target.value)}
                      placeholder={arg.description}
                    />
                  )}
                  {arg.description && (
                    <p className="text-xs text-muted-foreground">{arg.description}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Error display */}
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedCapId || isSubmitting}
            variant={isDangerous ? 'destructive' : 'default'}
          >
            {isSubmitting ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-4 w-4" />
            )}
            {isDangerous ? 'Run (Elevated)' : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Key decisions**:
- **Dynamic form generation**: Args are derived from the capability's JSON schema (`argsSchema.properties`). Each property becomes a form field.
- **Danger warning**: Capabilities with `dangerLevel >= 2` show an amber warning banner and use a destructive-styled submit button.
- **Textarea for prompts**: If the arg name is `prompt` or its description mentions `multiline`, render a `<Textarea>` instead of `<Input>`.
- **Validation**: Required args are validated client-side before submission. Server-side validation is performed by Phase 4a.

---

### Step 6: Log Viewer Toolbar

**File**: `src/components/executions/execution-log-toolbar.tsx`
**Purpose**: Toolbar above the log viewer with search, text wrap toggle, auto-scroll toggle, and log download.
**Depends on**: None (presentational component)

```typescript
// src/components/executions/execution-log-toolbar.tsx
'use client';

import { useState, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import {
  Search,
  WrapText,
  ArrowDownToLine,
  Download,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface LogToolbarState {
  searchQuery: string;
  wrapLines: boolean;
  autoScroll: boolean;
}

interface ExecutionLogToolbarProps {
  state: LogToolbarState;
  onStateChange: (state: LogToolbarState) => void;
  searchMatchCount: number;
  currentMatchIndex: number;
  onSearchNext: () => void;
  onSearchPrev: () => void;
  onDownload: () => void;
  lineCount: number;
  isTruncated: boolean;
}

export function ExecutionLogToolbar({
  state,
  onStateChange,
  searchMatchCount,
  currentMatchIndex,
  onSearchNext,
  onSearchPrev,
  onDownload,
  lineCount,
  isTruncated,
}: ExecutionLogToolbarProps) {
  const [searchFocused, setSearchFocused] = useState(false);

  const handleSearchChange = useCallback(
    (value: string) => {
      onStateChange({ ...state, searchQuery: value });
    },
    [state, onStateChange]
  );

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
      {/* Search */}
      <div className="relative flex items-center gap-1">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search logs..."
          value={state.searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          className="h-7 w-48 text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.shiftKey ? onSearchPrev() : onSearchNext();
            }
          }}
        />
        {state.searchQuery && searchFocused && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {searchMatchCount > 0
              ? `${currentMatchIndex + 1}/${searchMatchCount}`
              : 'No matches'}
          </span>
        )}
        {state.searchQuery && (
          <>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onSearchPrev}>
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onSearchNext}>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </>
        )}
      </div>

      <div className="flex-1" />

      {/* Line count + truncation indicator */}
      <span className="text-xs text-muted-foreground">
        {lineCount.toLocaleString()} lines
        {isTruncated && ' (truncated)'}
      </span>

      {/* Wrap toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={state.wrapLines}
            onPressedChange={(pressed) =>
              onStateChange({ ...state, wrapLines: pressed })
            }
            className="h-7 w-7"
            aria-label="Toggle line wrap"
          >
            <WrapText className="h-3.5 w-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Wrap lines</TooltipContent>
      </Tooltip>

      {/* Auto-scroll toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={state.autoScroll}
            onPressedChange={(pressed) =>
              onStateChange({ ...state, autoScroll: pressed })
            }
            className="h-7 w-7"
            aria-label="Toggle auto-scroll"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Auto-scroll to bottom</TooltipContent>
      </Tooltip>

      {/* Download */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDownload}>
            <Download className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Download logs</TooltipContent>
      </Tooltip>
    </div>
  );
}
```

---

### Step 7: Execution Log Viewer

**File**: `src/components/executions/execution-log-viewer.tsx`
**Purpose**: Terminal-style monospace log viewer that displays live-streamed execution output with ANSI color support, search highlighting, auto-scroll, and a 5000-line sliding window.
**Depends on**: Step 2 (SSE hook), Step 6 (toolbar), Step 1 (log-renderer)

```typescript
// src/components/executions/execution-log-viewer.tsx
'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { ArrowDown } from 'lucide-react';
import {
  useExecutionLogStream,
  type LogLine,
} from '@/lib/hooks/use-execution-log-stream';
import {
  ExecutionLogToolbar,
  type LogToolbarState,
} from './execution-log-toolbar';
import { ExecutionStatusBadge } from './execution-status-badge';
import { apiFetch } from '@/lib/api-types';

interface ExecutionLogViewerProps {
  executionId: string;
  className?: string;
}

export function ExecutionLogViewer({
  executionId,
  className,
}: ExecutionLogViewerProps) {
  const {
    lines,
    status,
    exitCode,
    isConnected,
    isDone,
    error,
    lineCount,
    isTruncated,
  } = useExecutionLogStream({ executionId });

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const [toolbarState, setToolbarState] = useState<LogToolbarState>({
    searchQuery: '',
    wrapLines: false,
    autoScroll: true,
  });
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);

  // --- Search ---

  const searchMatches = useMemo(() => {
    if (!toolbarState.searchQuery) return [];
    const query = toolbarState.searchQuery.toLowerCase();
    return lines.reduce<number[]>((matches, line, idx) => {
      // Strip HTML tags for text search
      const text = line.html.replace(/<[^>]*>/g, '').toLowerCase();
      if (text.includes(query)) matches.push(idx);
      return matches;
    }, []);
  }, [lines, toolbarState.searchQuery]);

  const navigateSearch = useCallback(
    (direction: 'next' | 'prev') => {
      if (searchMatches.length === 0) return;
      setSearchMatchIndex((prev) => {
        if (direction === 'next') {
          return (prev + 1) % searchMatches.length;
        }
        return (prev - 1 + searchMatches.length) % searchMatches.length;
      });
    },
    [searchMatches.length]
  );

  // Scroll to current search match
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const lineIdx = searchMatches[searchMatchIndex];
    const el = document.getElementById(`log-line-${lines[lineIdx]?.id}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [searchMatchIndex, searchMatches, lines]);

  // --- Auto-scroll ---

  // Detect user scroll up
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const { scrollTop, scrollHeight, clientHeight } = el;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    if (isAtBottom) {
      userScrolledUp.current = false;
      if (!toolbarState.autoScroll) {
        setToolbarState((prev) => ({ ...prev, autoScroll: true }));
      }
    } else {
      userScrolledUp.current = true;
      if (toolbarState.autoScroll) {
        setToolbarState((prev) => ({ ...prev, autoScroll: false }));
      }
    }
  }, [toolbarState.autoScroll]);

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (toolbarState.autoScroll && !userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines.length, toolbarState.autoScroll]);

  // --- Download ---

  const handleDownload = useCallback(async () => {
    try {
      const res = await apiFetch<string>(
        `/api/executions/${executionId}/logs`,
        { method: 'GET' }
      );
      const blob = new Blob([res.data ?? ''], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `execution-${executionId}.log`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: download from current lines
      const text = lines
        .map((l) => l.html.replace(/<[^>]*>/g, ''))
        .join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `execution-${executionId}.log`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [executionId, lines]);

  // --- Scroll to bottom button ---

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setToolbarState((prev) => ({ ...prev, autoScroll: true }));
    userScrolledUp.current = false;
  }, []);

  // Note: All HTML content rendered below is pre-sanitized via DOMPurify
  // in renderLogLine() (src/lib/log-renderer.ts). Only <span style="...">
  // elements are allowed through the sanitizer. This is safe for rendering.

  return (
    <div className={`flex flex-col rounded-md border border-border bg-[#1a1b26] ${className ?? ''}`}>
      {/* Toolbar */}
      <ExecutionLogToolbar
        state={toolbarState}
        onStateChange={setToolbarState}
        searchMatchCount={searchMatches.length}
        currentMatchIndex={searchMatchIndex}
        onSearchNext={() => navigateSearch('next')}
        onSearchPrev={() => navigateSearch('prev')}
        onDownload={handleDownload}
        lineCount={lineCount}
        isTruncated={isTruncated}
      />

      {/* Status bar */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1">
        {status && <ExecutionStatusBadge status={status} />}
        {isConnected && (
          <span className="text-xs text-green-400">Connected</span>
        )}
        {isDone && exitCode !== null && (
          <span className="text-xs text-muted-foreground">
            Exit code: {exitCode}
          </span>
        )}
        {error && (
          <span className="text-xs text-destructive">{error}</span>
        )}
      </div>

      {/* Truncation banner */}
      {isTruncated && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-400">
          Output exceeds 5,000 lines. Older lines have been removed. Download full logs for complete output.
        </div>
      )}

      {/* Log content — all HTML is pre-sanitized via DOMPurify (only span+style allowed) */}
      <div className="relative flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-[500px] overflow-auto p-3 font-mono text-xs leading-5"
        >
          {lines.map((line, idx) => {
            const isSearchMatch =
              toolbarState.searchQuery && searchMatches.includes(idx);
            const isCurrentMatch =
              isSearchMatch && searchMatches[searchMatchIndex] === idx;

            return (
              <div
                key={line.id}
                id={`log-line-${line.id}`}
                className={`${line.colorClass} ${
                  toolbarState.wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
                } ${isCurrentMatch ? 'bg-amber-500/30' : isSearchMatch ? 'bg-amber-500/10' : ''}`}
                dangerouslySetInnerHTML={{ __html: line.html }}
              />
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Scroll to bottom FAB */}
        {!toolbarState.autoScroll && (
          <Button
            size="sm"
            variant="secondary"
            className="absolute bottom-4 right-4 shadow-lg"
            onClick={scrollToBottom}
          >
            <ArrowDown className="mr-1.5 h-3.5 w-3.5" />
            Scroll to bottom
          </Button>
        )}
      </div>
    </div>
  );
}
```

**Key decisions**:
- **Sanitized HTML rendering**: All HTML is sanitized through DOMPurify in `renderLogLine` (Step 1). Only `<span style="...">` elements survive the sanitizer. This makes the rendering safe.
- **Auto-scroll pause**: When the user scrolls up (distance from bottom > 50px), auto-scroll pauses. A floating "Scroll to bottom" button appears. Scrolling back to the bottom re-enables auto-scroll.
- **Search**: Text search strips HTML tags to search raw content. Matching lines get a highlight background. Current match gets a stronger amber highlight.
- **Fixed height**: The viewer has `h-[500px]` as a default. The parent component can override via the `className` prop (e.g., `h-full` for fullscreen).

---

### Step 8: Execution Row + Table

**File**: `src/components/executions/execution-row.tsx`
**Purpose**: Single row in the execution list table displaying key execution metadata.

```typescript
// src/components/executions/execution-row.tsx

import { TableRow, TableCell } from '@/components/ui/table';
import { ExecutionStatusBadge } from './execution-status-badge';
import type { Execution } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';

interface ExecutionRowProps {
  execution: Execution & {
    agentName?: string;
    capabilityName?: string;
    taskTitle?: string;
  };
}

export function ExecutionRow({ execution }: ExecutionRowProps) {
  const duration =
    execution.startedAt && execution.completedAt
      ? `${Math.round(
          (new Date(execution.completedAt).getTime() -
            new Date(execution.startedAt).getTime()) /
            1000
        )}s`
      : execution.startedAt
        ? 'Running...'
        : '-';

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        <Link
          href={`/executions/${execution.id}`}
          className="text-primary hover:underline"
        >
          {execution.id.slice(0, 8)}
        </Link>
      </TableCell>
      <TableCell>
        <ExecutionStatusBadge status={execution.status} />
      </TableCell>
      <TableCell className="text-sm">
        {execution.agentName ?? execution.agentId.slice(0, 8)}
      </TableCell>
      <TableCell className="text-sm">
        {execution.capabilityName ?? '-'}
      </TableCell>
      <TableCell className="text-sm truncate max-w-[200px]">
        {execution.taskTitle ?? execution.taskId?.slice(0, 8) ?? '-'}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{duration}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {execution.createdAt
          ? formatDistanceToNow(new Date(execution.createdAt), { addSuffix: true })
          : '-'}
      </TableCell>
    </TableRow>
  );
}
```

**File**: `src/components/executions/execution-table.tsx`
**Purpose**: RSC table component that fetches and displays executions with server-side data loading.

```typescript
// src/components/executions/execution-table.tsx

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ExecutionRow } from './execution-row';
import { listExecutions } from '@/lib/services/execution-service';

interface ExecutionTableProps {
  taskId?: string;   // Filter by task
  agentId?: string;  // Filter by agent
  limit?: number;
}

export async function ExecutionTable({
  taskId,
  agentId,
  limit = 25,
}: ExecutionTableProps) {
  const { data: executions } = await listExecutions({ taskId, agentId, limit });

  if (executions.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        No executions yet
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[100px]">ID</TableHead>
          <TableHead className="w-[120px]">Status</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Capability</TableHead>
          <TableHead>Task</TableHead>
          <TableHead className="w-[80px]">Duration</TableHead>
          <TableHead className="w-[120px]">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {executions.map((execution) => (
          <ExecutionRow key={execution.id} execution={execution} />
        ))}
      </TableBody>
    </Table>
  );
}
```

---

### Step 9: Execution Message Input (Bidirectional Communication)

**File**: `src/components/executions/execution-message-input.tsx`
**Purpose**: Text input and send button for sending follow-up messages to a running execution. Only visible when the execution is in `running` status and the adapter supports bidirectional communication.
**Depends on**: Phase 4a message API route

```typescript
// src/components/executions/execution-message-input.tsx
'use client';

import { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Send, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-types';
import type { ExecutionStatus } from '@/lib/types';

interface ExecutionMessageInputProps {
  executionId: string;
  status: ExecutionStatus | null;
  supportsBidirectional: boolean;
  onMessageSent?: (message: string) => void;
}

export function ExecutionMessageInput({
  executionId,
  status,
  supportsBidirectional,
  onMessageSent,
}: ExecutionMessageInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Only show when execution is running
  if (status !== 'running') return null;

  const isDisabled = !supportsBidirectional;

  const handleSend = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || isSending) return;

    setIsSending(true);
    setError(null);

    try {
      await apiFetch(`/api/executions/${executionId}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: trimmed }),
      });

      setMessage('');
      onMessageSent?.(trimmed);
      textareaRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  }, [message, isSending, executionId, onMessageSent]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+Enter or Cmd+Enter to send
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const input = (
    <div className="flex items-end gap-2 border-t border-border bg-muted/30 p-3">
      <div className="flex-1 space-y-1">
        <Textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isDisabled
              ? 'This agent does not support interactive messages'
              : 'Send a message to the running agent... (Ctrl+Enter to send)'
          }
          disabled={isDisabled || isSending}
          rows={2}
          className="min-h-[60px] resize-none text-sm"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <Button
        size="icon"
        onClick={handleSend}
        disabled={isDisabled || isSending || !message.trim()}
        className="h-10 w-10 shrink-0"
      >
        {isSending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Send className="h-4 w-4" />
        )}
      </Button>
    </div>
  );

  if (isDisabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{input}</TooltipTrigger>
        <TooltipContent>
          This agent adapter does not support bidirectional communication.
        </TooltipContent>
      </Tooltip>
    );
  }

  return input;
}
```

**Key decisions**:
- **Ctrl+Enter to send**: Standard pattern for multiline inputs. Enter inserts a newline; Ctrl+Enter (or Cmd+Enter on Mac) sends.
- **Disabled state with tooltip**: When the adapter does not support bidirectional (e.g., generic adapter), the input is disabled and a tooltip explains why.
- **Callback to parent**: `onMessageSent` fires after a successful send. The parent (log viewer or detail page) can use this to optimistically append the message to the log display.

---

### Step 10: Session Resume UI

**File**: `src/components/executions/session-resume-button.tsx`
**Purpose**: "Continue Session" button shown on completed executions that have a `session_ref`. Creates a new execution linked to the original via `parentExecutionId`.
**Depends on**: Phase 4a execution creation API, session infrastructure

```typescript
// src/components/executions/session-resume-button.tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCw, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-types';
import type { Execution, ExecutionStatus } from '@/lib/types';
import { useRouter } from 'next/navigation';

interface SessionResumeButtonProps {
  execution: Execution;
  onResumed?: (newExecution: Execution) => void;
}

export function SessionResumeButton({
  execution,
  onResumed,
}: SessionResumeButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  // Only show for terminal executions with a session reference
  const isTerminal: boolean =
    execution.status === 'succeeded' ||
    execution.status === 'failed' ||
    execution.status === 'cancelled';
  const hasSession = !!execution.sessionRef;

  if (!isTerminal || !hasSession) return null;

  async function handleResume() {
    setIsLoading(true);
    try {
      const res = await apiFetch<Execution>('/api/executions', {
        method: 'POST',
        body: JSON.stringify({
          taskId: execution.taskId,
          agentId: execution.agentId,
          capabilityId: execution.capabilityId,
          parentExecutionId: execution.id,
          sessionRef: execution.sessionRef,
        }),
      });

      if (res.data) {
        onResumed?.(res.data);
        router.push(`/executions/${res.data.id}`);
      }
    } catch (err) {
      console.error('Failed to resume session:', err);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleResume} disabled={isLoading}>
      {isLoading ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCw className="mr-1.5 h-3.5 w-3.5" />
      )}
      Continue Session
    </Button>
  );
}
```

**File**: `src/components/executions/session-chain-indicator.tsx`
**Purpose**: Small indicator on task cards showing the number of execution turns in a session chain.

```typescript
// src/components/executions/session-chain-indicator.tsx

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageSquare } from 'lucide-react';

interface SessionChainIndicatorProps {
  turnCount: number;
}

export function SessionChainIndicator({ turnCount }: SessionChainIndicatorProps) {
  if (turnCount <= 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {turnCount} execution turn{turnCount !== 1 ? 's' : ''} in this session chain
      </TooltipContent>
    </Tooltip>
  );
}
```

---

### Step 11: Web Terminal Component

**File**: `src/components/terminal/terminal-component.tsx`
**Purpose**: Interactive web terminal using xterm.js v6, connecting to the terminal server via Socket.io. Dynamically imported (SSR-safe). Supports WebGL rendering with DOM fallback, auto-fit on resize, and search.
**Depends on**: Terminal server running on `:4101`, JWT token endpoint

```typescript
// src/components/terminal/terminal-component.tsx
'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import type { SearchAddon as SearchAddonType } from '@xterm/addon-search';
import type { Socket } from 'socket.io-client';
import { apiFetch } from '@/lib/api-types';

// --- Theme ---

const TERMINAL_THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467C',
  selectionForeground: '#c0caf5',
  selectionInactiveBackground: '#292e42',
  black: '#15161E',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

// --- Props ---

interface TerminalComponentProps {
  sessionName: string;
  fontSize?: number;
  className?: string;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: string) => void;
}

export function TerminalComponent({
  sessionName,
  fontSize = 14,
  className,
  onConnected,
  onDisconnected,
  onError,
}: TerminalComponentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddonType | null>(null);
  const searchAddonRef = useRef<SearchAddonType | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // --- Search API (exposed via ref or callback) ---

  const search = useCallback((query: string) => {
    searchAddonRef.current?.findNext(query);
  }, []);

  const searchPrev = useCallback((query: string) => {
    searchAddonRef.current?.findPrevious(query);
  }, []);

  // --- Initialize terminal + Socket.io ---

  useEffect(() => {
    let terminal: XTerminal;
    let socket: Socket;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    const init = async () => {
      // 1. Request JWT token for the WebSocket connection
      let token: string;
      try {
        const res = await apiFetch<{ token: string }>('/api/terminal/token', {
          method: 'POST',
          body: JSON.stringify({ sessionName }),
        });
        token = res.data?.token ?? '';
        if (!token) throw new Error('No token received');
      } catch (err) {
        onError?.('Failed to authenticate terminal session');
        setIsLoading(false);
        return;
      }

      if (disposed || !containerRef.current) return;

      // 2. Dynamic import all xterm packages (SSR-safe)
      const [
        { Terminal },
        { FitAddon },
        { WebLinksAddon },
        { SearchAddon },
        { WebglAddon },
        { io },
      ] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-search'),
        import('@xterm/addon-webgl'),
        import('socket.io-client'),
      ]);

      // Also import the CSS
      await import('@xterm/xterm/css/xterm.css');

      if (disposed || !containerRef.current) return;

      // 3. Create terminal instance
      terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        lineHeight: 1.2,
        scrollback: 5000,
        theme: TERMINAL_THEME,
        allowTransparency: false,
        convertEol: true,
      });

      // 4. Load addons
      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.loadAddon(searchAddon);

      terminal.open(containerRef.current);

      // WebGL renderer with DOM fallback
      try {
        terminal.loadAddon(new WebglAddon());
      } catch {
        console.warn('WebGL renderer not available, using DOM renderer');
      }

      fitAddon.fit();
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // 5. Connect Socket.io
      const terminalServerUrl =
        typeof window !== 'undefined'
          ? `${window.location.protocol}//${window.location.hostname}:4101`
          : 'http://localhost:4101';

      socket = io(terminalServerUrl, {
        query: { token, session: sessionName },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      });

      socketRef.current = socket;

      // 6. Wire events

      // Terminal server -> xterm
      socket.on('terminal:output', (data: string) => {
        terminal.write(data);
      });

      // xterm -> Terminal server
      terminal.onData((data: string) => {
        socket.emit('terminal:input', data);
      });

      // Terminal resize -> server
      terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        socket.emit('terminal:resize', { cols, rows });
      });

      // Connection status
      socket.on('connect', () => {
        setIsLoading(false);
        onConnected?.();
      });

      socket.on('disconnect', () => {
        onDisconnected?.();
      });

      socket.on('connect_error', (err: Error) => {
        onError?.(`Terminal connection failed: ${err.message}`);
        setIsLoading(false);
      });

      // 7. ResizeObserver for auto-fit
      resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      resizeObserver.observe(containerRef.current);
    };

    init();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      socketRef.current?.disconnect();
      terminalRef.current?.dispose();
    };
  }, [sessionName, fontSize, onConnected, onDisconnected, onError]);

  // Re-fit when fontSize changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      fitAddonRef.current?.fit();
    }
  }, [fontSize]);

  return (
    <div className={`relative ${className ?? ''}`}>
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#1a1b26]">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            Connecting to terminal...
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ minHeight: '300px' }}
      />
    </div>
  );
}
```

**Key decisions**:
- **All imports are dynamic**: xterm.js, its addons, socket.io-client, and the xterm CSS are all lazily loaded inside `useEffect`. This ensures zero SSR failures.
- **JWT authentication**: Before connecting Socket.io, the component requests a short-lived JWT from `/api/terminal/token`. The token is passed as a query parameter on the WebSocket connection.
- **Socket.io transport**: Forced to `websocket` only (no polling fallback) for lower latency.
- **WebGL with fallback**: The WebGL addon is loaded in a try/catch. If WebGL2 is unavailable (rare on modern browsers), the default DOM renderer is used.
- **ResizeObserver**: The `FitAddon` is re-invoked whenever the container element resizes, ensuring the terminal grid always fills its container.

---

### Step 12: Terminal Toolbar

**File**: `src/components/terminal/terminal-toolbar.tsx`
**Purpose**: Toolbar for the web terminal with search, font size controls, and fullscreen toggle.
**Depends on**: None (presentational)

```typescript
// src/components/terminal/terminal-toolbar.tsx
'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Search,
  Minus,
  Plus,
  Maximize2,
  Minimize2,
} from 'lucide-react';

interface TerminalToolbarProps {
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  isFullscreen: boolean;
  onFullscreenToggle: () => void;
  onSearch: (query: string) => void;
  onSearchPrev: (query: string) => void;
}

export function TerminalToolbar({
  fontSize,
  onFontSizeChange,
  isFullscreen,
  onFullscreenToggle,
  onSearch,
  onSearchPrev,
}: TerminalToolbarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const MIN_FONT = 10;
  const MAX_FONT = 24;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
      {/* Search */}
      <div className="flex items-center gap-1">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-7 w-40 text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.shiftKey
                ? onSearchPrev(searchQuery)
                : onSearch(searchQuery);
            }
          }}
        />
      </div>

      <div className="flex-1" />

      {/* Font size */}
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onFontSizeChange(Math.max(MIN_FONT, fontSize - 1))}
              disabled={fontSize <= MIN_FONT}
            >
              <Minus className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Decrease font size</TooltipContent>
        </Tooltip>
        <span className="w-6 text-center text-xs text-muted-foreground">
          {fontSize}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onFontSizeChange(Math.min(MAX_FONT, fontSize + 1))}
              disabled={fontSize >= MAX_FONT}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Increase font size</TooltipContent>
        </Tooltip>
      </div>

      {/* Fullscreen */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onFullscreenToggle}
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</TooltipContent>
      </Tooltip>
    </div>
  );
}
```

---

### Step 13: Terminal Panel Wrapper

**File**: `src/components/terminal/terminal-panel.tsx`
**Purpose**: Wraps the terminal component with a toolbar and handles fullscreen overlay mode. Used on the execution detail page as an expandable bottom panel.
**Depends on**: Steps 11 and 12

```typescript
// src/components/terminal/terminal-panel.tsx
'use client';

import { useState, useCallback } from 'react';
import { TerminalComponent } from './terminal-component';
import { TerminalToolbar } from './terminal-toolbar';
import { Button } from '@/components/ui/button';
import { Terminal, X } from 'lucide-react';

interface TerminalPanelProps {
  sessionName: string;
  className?: string;
}

export function TerminalPanel({ sessionName, className }: TerminalPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [searchFn, setSearchFn] = useState<{
    search: (q: string) => void;
    searchPrev: (q: string) => void;
  } | null>(null);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        className={className}
      >
        <Terminal className="mr-1.5 h-3.5 w-3.5" />
        Open Terminal
      </Button>
    );
  }

  const panelClasses = isFullscreen
    ? 'fixed inset-0 z-50 flex flex-col bg-background'
    : `flex flex-col rounded-md border border-border ${className ?? ''}`;

  return (
    <div className={panelClasses}>
      <div className="flex items-center justify-between">
        <TerminalToolbar
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
          isFullscreen={isFullscreen}
          onFullscreenToggle={toggleFullscreen}
          onSearch={(q) => searchFn?.search(q)}
          onSearchPrev={(q) => searchFn?.searchPrev(q)}
        />
        <Button
          variant="ghost"
          size="icon"
          className="mr-2 h-7 w-7"
          onClick={() => {
            setIsOpen(false);
            setIsFullscreen(false);
          }}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className={isFullscreen ? 'flex-1' : 'h-[350px]'}>
        <TerminalComponent
          sessionName={sessionName}
          fontSize={fontSize}
          className="h-full"
        />
      </div>
    </div>
  );
}
```

---

### Step 14: Execution Detail Page

**File**: `src/app/(dashboard)/executions/[id]/page.tsx`
**Purpose**: Full detail page for a single execution, combining the log viewer, message input, session resume, cancel, and terminal panel.
**Depends on**: Steps 3-13

```typescript
// src/app/(dashboard)/executions/[id]/page.tsx

import { notFound } from 'next/navigation';
import { getExecution } from '@/lib/services/execution-service';
import { ExecutionDetailClient } from './execution-detail-client';

interface ExecutionDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ExecutionDetailPage({
  params,
}: ExecutionDetailPageProps) {
  const { id } = await params;

  const execution = await getExecution(id);
  if (!execution) notFound();

  return <ExecutionDetailClient execution={execution} />;
}
```

**File**: `src/app/(dashboard)/executions/[id]/execution-detail-client.tsx`
**Purpose**: Client wrapper that composes all execution sub-components.

```typescript
// src/app/(dashboard)/executions/[id]/execution-detail-client.tsx
'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { ExecutionLogViewer } from '@/components/executions/execution-log-viewer';
import { ExecutionMessageInput } from '@/components/executions/execution-message-input';
import { ExecutionStatusBadge } from '@/components/executions/execution-status-badge';
import { ExecutionCancelButton } from '@/components/executions/execution-cancel-button';
import { SessionResumeButton } from '@/components/executions/session-resume-button';
import { TerminalPanel } from '@/components/terminal/terminal-panel';
import type { Execution } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';

interface ExecutionDetailClientProps {
  execution: Execution & {
    agentName?: string;
    capabilityName?: string;
    taskTitle?: string;
    adapterType?: string;
    tmuxSession?: string | null;
  };
}

export function ExecutionDetailClient({
  execution,
}: ExecutionDetailClientProps) {
  const router = useRouter();

  const supportsBidirectional =
    execution.adapterType !== 'generic' && execution.adapterType !== undefined;
  const hasTmuxSession = !!execution.tmuxSession;

  const handleCancelled = useCallback(() => {
    router.refresh();
  }, [router]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/executions">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-lg font-semibold">
              Execution {execution.id.slice(0, 8)}
            </h1>
            <p className="text-sm text-muted-foreground">
              {execution.agentName ?? execution.agentId.slice(0, 8)}
              {execution.capabilityName && ` / ${execution.capabilityName}`}
              {' — '}
              {formatDistanceToNow(new Date(execution.createdAt), {
                addSuffix: true,
              })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ExecutionStatusBadge status={execution.status} />
          <ExecutionCancelButton
            executionId={execution.id}
            status={execution.status}
            onCancelled={handleCancelled}
          />
          <SessionResumeButton execution={execution} />
          {execution.taskId && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/tasks?selected=${execution.taskId}`}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                View Task
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-4 rounded-md border border-border p-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">Task</p>
          <p className="text-sm font-medium truncate">
            {execution.taskTitle ?? execution.taskId?.slice(0, 8) ?? '-'}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Agent</p>
          <p className="text-sm font-medium">
            {execution.agentName ?? execution.agentId.slice(0, 8)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Duration</p>
          <p className="text-sm font-medium">
            {execution.startedAt && execution.completedAt
              ? `${Math.round(
                  (new Date(execution.completedAt).getTime() -
                    new Date(execution.startedAt).getTime()) /
                    1000
                )}s`
              : execution.startedAt
                ? 'Running...'
                : 'Pending'}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Exit Code</p>
          <p className="text-sm font-medium">
            {execution.exitCode !== null && execution.exitCode !== undefined
              ? execution.exitCode
              : '-'}
          </p>
        </div>
      </div>

      {/* Log Viewer */}
      <ExecutionLogViewer
        executionId={execution.id}
        className="min-h-[400px]"
      />

      {/* Message Input (bidirectional) */}
      <ExecutionMessageInput
        executionId={execution.id}
        status={execution.status}
        supportsBidirectional={supportsBidirectional}
      />

      {/* Terminal Panel (only when tmux session exists) */}
      {hasTmuxSession && (
        <TerminalPanel
          sessionName={execution.tmuxSession!}
          className="mt-4"
        />
      )}
    </div>
  );
}
```

---

### Step 15: Fullscreen Terminal Page

**File**: `src/app/(dashboard)/executions/[id]/terminal/page.tsx`
**Purpose**: Standalone fullscreen terminal page for maximum screen real estate.
**Depends on**: Steps 11-12

```typescript
// src/app/(dashboard)/executions/[id]/terminal/page.tsx

import { notFound } from 'next/navigation';
import { getExecution } from '@/lib/services/execution-service';
import { TerminalPageClient } from './terminal-page-client';

interface TerminalPageProps {
  params: Promise<{ id: string }>;
}

export default async function TerminalPage({ params }: TerminalPageProps) {
  const { id } = await params;

  const execution = await getExecution(id);
  if (!execution || !execution.tmuxSession) notFound();

  return (
    <TerminalPageClient
      executionId={execution.id}
      sessionName={execution.tmuxSession}
    />
  );
}
```

**File**: `src/app/(dashboard)/executions/[id]/terminal/terminal-page-client.tsx`
**Purpose**: Client-side fullscreen terminal wrapper with dynamic import.

```typescript
// src/app/(dashboard)/executions/[id]/terminal/terminal-page-client.tsx
'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { TerminalToolbar } from '@/components/terminal/terminal-toolbar';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

// Dynamic import with ssr: false — xterm.js requires window
const TerminalComponent = dynamic(
  () =>
    import('@/components/terminal/terminal-component').then(
      (m) => m.TerminalComponent
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-[#1a1b26] text-sm text-muted-foreground">
        Loading terminal...
      </div>
    ),
  }
);

interface TerminalPageClientProps {
  executionId: string;
  sessionName: string;
}

export function TerminalPageClient({
  executionId,
  sessionName,
}: TerminalPageClientProps) {
  const [fontSize, setFontSize] = useState(14);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/executions/${executionId}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-sm font-medium">
          Terminal — {sessionName}
        </h1>
        <div className="flex-1" />
        <TerminalToolbar
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
          isFullscreen={true}
          onFullscreenToggle={() => {
            // Navigate back to execution detail
            window.history.back();
          }}
          onSearch={() => {}}
          onSearchPrev={() => {}}
        />
      </div>

      {/* Terminal */}
      <div className="flex-1">
        <TerminalComponent
          sessionName={sessionName}
          fontSize={fontSize}
          className="h-full"
        />
      </div>
    </div>
  );
}
```

---

### Step 16: Executions List Page

**File**: `src/app/(dashboard)/executions/page.tsx`
**Purpose**: Main executions list page with the RSC execution table.
**Depends on**: Step 8

```typescript
// src/app/(dashboard)/executions/page.tsx

import { Suspense } from 'react';
import { ExecutionTable } from '@/components/executions/execution-table';

interface ExecutionsPageProps {
  searchParams: Promise<{ taskId?: string; agentId?: string }>;
}

export default async function ExecutionsPage({
  searchParams,
}: ExecutionsPageProps) {
  const { taskId, agentId } = await searchParams;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Executions</h1>
          <p className="text-sm text-muted-foreground">
            View and manage agent execution history
          </p>
        </div>
      </div>

      <Suspense
        fallback={
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Loading executions...
          </div>
        }
      >
        <ExecutionTable taskId={taskId} agentId={agentId} />
      </Suspense>
    </div>
  );
}
```

---

### Step 17: Wire Task Detail Sheet — Execution History + Run Button

**File**: Modify `src/components/tasks/task-detail-sheet.tsx` (from Phase 3)
**Purpose**: Add execution history section and "Run" button to the existing task detail sheet.
**Depends on**: Phase 3 (task detail sheet), Steps 5 and 8

Add the following sections to the existing task detail sheet component:

```typescript
// --- Add these imports to the existing task-detail-sheet.tsx ---
import { Suspense, useState } from 'react';
import { Play } from 'lucide-react';
import { ExecutionTable } from '@/components/executions/execution-table';
import { ExecutionTriggerDialog } from '@/components/executions/execution-trigger-dialog';
import { SessionChainIndicator } from '@/components/executions/session-chain-indicator';

// --- Add inside the sheet content, after the existing sections ---

// Execution history section
function TaskExecutionSection({ taskId, agentId, sessionTurnCount }: {
  taskId: string;
  agentId: string | null;
  sessionTurnCount: number;
}) {
  const [triggerOpen, setTriggerOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Executions</h3>
          {sessionTurnCount > 0 && (
            <SessionChainIndicator turnCount={sessionTurnCount} />
          )}
        </div>
        {agentId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTriggerOpen(true)}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Run
          </Button>
        )}
      </div>

      <Suspense
        fallback={
          <div className="text-xs text-muted-foreground">Loading...</div>
        }
      >
        <ExecutionTable taskId={taskId} limit={5} />
      </Suspense>

      {agentId && (
        <ExecutionTriggerDialog
          open={triggerOpen}
          onOpenChange={setTriggerOpen}
          taskId={taskId}
          agentId={agentId}
          onExecutionCreated={() => {
            setTriggerOpen(false);
            // Router refresh will reload the RSC table
          }}
        />
      )}
    </div>
  );
}
```

Place this section after the dependencies section in the sheet, separated by a `<Separator />`.

---

### Step 18: Add Navigation Links

**File**: Modify `src/components/layout/sidebar.tsx` (from Phase 1)
**Purpose**: Add "Executions" link to the sidebar navigation.

```typescript
// Add to the navigation items array in sidebar.tsx:
{
  label: 'Executions',
  href: '/executions',
  icon: PlayCircle, // from lucide-react
}
```

---

## API Route Summary

All API routes are implemented in Phase 4a (backend). The frontend consumes them via `apiFetch`:

| Route | Method | Purpose | Frontend Consumer |
|-------|--------|---------|-------------------|
| `/api/executions` | `GET` | List executions (with `taskId`, `agentId` query filters) | `ExecutionTable` (RSC, server-side) |
| `/api/executions` | `POST` | Create new execution | `ExecutionTriggerDialog`, `SessionResumeButton` |
| `/api/executions/[id]` | `GET` | Get execution detail | Execution detail page (RSC) |
| `/api/executions/[id]/cancel` | `POST` | Cancel running execution | `ExecutionCancelButton` |
| `/api/executions/[id]/logs` | `GET` | Download full log file | `ExecutionLogViewer` download button |
| `/api/executions/[id]/logs/stream` | `GET` | SSE log stream | `useExecutionLogStream` hook |
| `/api/executions/[id]/message` | `POST` | Send message to running execution | `ExecutionMessageInput` |
| `/api/terminal/token` | `POST` | Get JWT for terminal WebSocket | `TerminalComponent` |

---

## File Inventory

### New Files (20 files)

| # | File | Type | Lines (est.) |
|---|------|------|-------------|
| 1 | `src/lib/log-renderer.ts` | Utility | ~55 |
| 2 | `src/lib/hooks/use-execution-log-stream.ts` | Hook | ~160 |
| 3 | `src/components/executions/execution-status-badge.tsx` | Component | ~35 |
| 4 | `src/components/executions/execution-cancel-button.tsx` | Component (client) | ~55 |
| 5 | `src/components/executions/execution-trigger-dialog.tsx` | Component (client) | ~145 |
| 6 | `src/components/executions/execution-log-toolbar.tsx` | Component (client) | ~95 |
| 7 | `src/components/executions/execution-log-viewer.tsx` | Component (client) | ~165 |
| 8 | `src/components/executions/execution-row.tsx` | Component | ~50 |
| 9 | `src/components/executions/execution-table.tsx` | Component (RSC) | ~45 |
| 10 | `src/components/executions/execution-message-input.tsx` | Component (client) | ~95 |
| 11 | `src/components/executions/session-resume-button.tsx` | Component (client) | ~55 |
| 12 | `src/components/executions/session-chain-indicator.tsx` | Component | ~25 |
| 13 | `src/components/terminal/terminal-component.tsx` | Component (client) | ~185 |
| 14 | `src/components/terminal/terminal-toolbar.tsx` | Component (client) | ~85 |
| 15 | `src/components/terminal/terminal-panel.tsx` | Component (client) | ~75 |
| 16 | `src/app/(dashboard)/executions/page.tsx` | Page (RSC) | ~30 |
| 17 | `src/app/(dashboard)/executions/[id]/page.tsx` | Page (RSC) | ~15 |
| 18 | `src/app/(dashboard)/executions/[id]/execution-detail-client.tsx` | Component (client) | ~130 |
| 19 | `src/app/(dashboard)/executions/[id]/terminal/page.tsx` | Page (RSC) | ~15 |
| 20 | `src/app/(dashboard)/executions/[id]/terminal/terminal-page-client.tsx` | Component (client) | ~65 |

### Modified Files (2 files)

| # | File | Change |
|---|------|--------|
| 1 | `src/components/tasks/task-detail-sheet.tsx` | Add execution history section + "Run" button |
| 2 | `src/components/layout/sidebar.tsx` | Add "Executions" navigation link |

---

## Testing Checklist

All test files go in `src/__tests__/` mirroring the source structure.

### Unit Tests

**File**: `src/__tests__/lib/log-renderer.test.ts`

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `renderLogLine` strips dangerous HTML from raw input | `renderLogLine('<script>alert(1)</script>')` returns escaped text, no `<script>` tag |
| 2 | `renderLogLine` converts ANSI bold to `<span>` | `renderLogLine('\x1b[1mBold\x1b[0m')` contains `<span style="font-weight:bold">` |
| 3 | `renderLogLine` converts ANSI colors to styled spans | `renderLogLine('\x1b[31mRed\x1b[0m')` contains a `<span>` with red color style |
| 4 | `renderLogLine` passes plain text through unchanged | `renderLogLine('hello world')` returns `'hello world'` |
| 5 | `renderLogChunk` splits multiline content | `renderLogChunk('line1\nline2')` returns array of length 2 |
| 6 | `getStreamColorClass` returns correct Tailwind classes | `stdout` -> `text-zinc-100`, `stderr` -> `text-amber-400`, `system` -> `text-blue-400`, `user` -> `text-green-400` |
| 7 | `renderLogLine` sanitizes nested HTML inside ANSI | `renderLogLine('\x1b[31m<img onerror=alert(1)>\x1b[0m')` contains no `<img>` tag |

**File**: `src/__tests__/lib/hooks/use-execution-log-stream.test.ts`

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Hook creates EventSource with correct URL | `new EventSource('/api/executions/abc/logs/stream')` called |
| 2 | Hook processes `catchup` event | Bulk content splits into multiple log lines |
| 3 | Hook processes `log` event with correct stream class | `stderr` log line gets `text-amber-400` class |
| 4 | Hook processes `done` event and sets `isDone` | `isDone` becomes true, `isConnected` becomes false |
| 5 | Hook reconnects with exponential backoff on error | After first error, retries at 1s; after second, at 2s |
| 6 | Hook does not reconnect after `done` event | Error after `done` does not trigger retry |
| 7 | Hook enforces 5000-line sliding window | After appending 5500 lines, only 5000 remain; `isTruncated` is true |
| 8 | Hook resets state when `executionId` changes | Lines array is cleared, `isDone` resets to false |

**File**: `src/__tests__/components/executions/execution-trigger-dialog.test.tsx`

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Dialog fetches capabilities on open | `apiFetch('/api/agents/.../capabilities')` is called |
| 2 | Selecting a capability renders its args form | Select capability -> Input fields appear based on `argsSchema` |
| 3 | Required arg validation prevents submission | Leave required field empty, click Run -> error message shown |
| 4 | Danger warning shown for level >= 2 capability | Selecting level 2 capability -> amber warning banner visible |
| 5 | Successful submission calls `onExecutionCreated` | Fill form, click Run -> `POST /api/executions` called, callback invoked |
| 6 | Prompt argument renders as Textarea | Arg named `prompt` renders `<textarea>` not `<input>` |

### Integration Tests

These test full component interactions with mocked API responses.

**File**: `src/__tests__/integration/execution-detail.test.tsx`

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Execution detail page renders with log viewer | SSE stream connects, log lines appear in viewer |
| 2 | Send message to running execution | Type message, press Ctrl+Enter -> `POST /api/executions/.../message` called |
| 3 | Message input hidden when execution is not running | Completed execution -> no message input visible |
| 4 | Message input disabled for generic adapter | `adapterType='generic'` -> input disabled with tooltip |
| 5 | Cancel button sends cancel request | Click Cancel, confirm -> `POST /api/executions/.../cancel` called |
| 6 | Session resume creates new execution | Click "Continue Session" -> `POST /api/executions` with `parentExecutionId` |
| 7 | Terminal panel appears when tmux session exists | Execution with `tmuxSession` -> "Open Terminal" button visible |

**File**: `src/__tests__/integration/terminal.test.tsx`

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Terminal requests JWT token on mount | `POST /api/terminal/token` called with `sessionName` |
| 2 | Terminal connects Socket.io with token | `io()` called with `query: { token, session }` |
| 3 | Terminal writes server output to xterm | `terminal:output` event -> `terminal.write()` called |
| 4 | Terminal sends user input to server | `terminal.onData()` fires -> `terminal:input` event emitted |
| 5 | Terminal handles resize via ResizeObserver | Container resize -> `fitAddon.fit()` called, `terminal:resize` emitted |

---

## Verification

Phase 4b is complete when all of the following are true:

1. **Executions list page** at `/executions` renders a table with status badges, agent names, and duration
2. **Execution detail page** at `/executions/[id]` shows metadata, log viewer, and status
3. **Log viewer** streams live output via SSE with ANSI color rendering
4. **Log viewer auto-scroll** pauses when user scrolls up, resumes via "Scroll to bottom" button
5. **Log viewer search** highlights matching lines and navigates between matches
6. **Log download** fetches full log file from the API
7. **Truncation banner** appears when output exceeds 5,000 lines
8. **Execution trigger dialog** opens from task detail sheet "Run" button, shows capabilities and arg form
9. **Danger warning** displays for capabilities with level >= 2
10. **Cancel button** sends cancel request and updates UI
11. **Message input** appears for running executions, sends via POST, hidden for non-running
12. **Message input disabled** with tooltip for adapters that do not support bidirectional
13. **Session resume** "Continue Session" button creates linked execution and navigates to it
14. **Session chain indicator** shows turn count on task cards
15. **Web terminal** connects to `:4101` via Socket.io, renders in xterm.js with WebGL
16. **Terminal search** finds text in terminal buffer
17. **Terminal font size** adjustable via toolbar buttons
18. **Terminal fullscreen** page at `/executions/[id]/terminal` fills entire viewport
19. **"Open Terminal"** button only shows when tmux session exists on the execution
20. **Sidebar** includes "Executions" navigation link
21. **All unit tests pass**: log renderer, SSE hook, trigger dialog
22. **All integration tests pass**: execution detail flow, terminal connection

### Manual Smoke Test

```
1. Navigate to /tasks, click a task card with an assigned agent
2. Click "Run" button in the detail sheet
3. Select a capability, fill in args, click "Run"
4. Verify redirect to /executions/{id}
5. Watch log lines stream in the viewer with ANSI colors
6. Scroll up -> "Scroll to bottom" button appears
7. Click "Scroll to bottom" -> auto-scroll resumes
8. Type in search box -> matching lines highlighted
9. Click "Download" -> log file downloads
10. If execution is running, type a message in the input
11. Press Ctrl+Enter -> message sends, appears in log with green prefix
12. Click "Open Terminal" (if tmux session exists) -> terminal panel expands
13. Type in terminal -> interactive shell responds
14. Click fullscreen -> terminal fills viewport
15. Click "Cancel" -> execution cancels, status updates
16. On completed execution with session_ref, click "Continue Session"
17. Verify new execution page opens with linked parentExecutionId
18. Navigate to /executions -> verify table lists all executions
```
