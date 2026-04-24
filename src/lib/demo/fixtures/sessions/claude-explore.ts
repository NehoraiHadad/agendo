/**
 * Claude Explore — 90-second "running" arc.
 *
 * Story: Claude is exploring the agendo repo to understand how SSE catchup works.
 * Session status: running (no session:end — arc ends before that).
 *
 * Session ID: 77777777-7777-4777-a777-777777777777
 */

import {
  sessionStart,
  agentText,
  toolStart,
  toolEnd,
  agentResult,
  permissionRequest,
  modeChange,
  streamedText,
  makeToolUseId,
  type ReplayableEvent,
} from '@/lib/demo/sse/factories';

const SESSION_ID = '77777777-7777-4777-a777-777777777777';

// Pre-generate toolUseIds so start/end pairs always match.
const TOOL_READ_HOOK = makeToolUseId(SESSION_ID);
const TOOL_READ_EVENTS_ROUTE = makeToolUseId(SESSION_ID);
const TOOL_READ_SSE_PROXY = makeToolUseId(SESSION_ID);
const TOOL_WRITE_NOTES = makeToolUseId(SESSION_ID);

export const claudeExploreEvents: ReplayableEvent[] = [
  // 1. t=0 — session:init
  sessionStart(SESSION_ID, 0, 0),

  // 2. t=500 — streaming intro text
  ...streamedText(
    SESSION_ID,
    "I'll start by looking at the session detail viewer and tracing SSE event consumption. Let me read `src/hooks/use-session-stream.ts` first.",
    500,
    3000,
    10,
  ),

  // 3. t=4000 — Read use-session-stream.ts
  toolStart(
    SESSION_ID,
    TOOL_READ_HOOK,
    'Read',
    { path: 'src/hooks/use-session-stream.ts' },
    4000,
    50,
  ),

  // 4. t=4300 — tool-end: file read complete
  toolEnd(
    SESSION_ID,
    TOOL_READ_HOOK,
    { lines: 312, preview: '...imports EventSource...' },
    4300,
    300,
    51,
  ),

  // 5. t=4800 — streaming follow-up
  ...streamedText(
    SESSION_ID,
    'Now I see the hook uses lastEventId for reconnect. Let me check what the API route does with that header.',
    4800,
    3000,
    60,
  ),

  // 6. t=8500 — Read events/route.ts
  toolStart(
    SESSION_ID,
    TOOL_READ_EVENTS_ROUTE,
    'Read',
    { path: 'src/app/api/sessions/[id]/events/route.ts' },
    8500,
    90,
  ),

  // 7. t=8900 — tool-end: route file read
  toolEnd(
    SESSION_ID,
    TOOL_READ_EVENTS_ROUTE,
    {
      lines: 48,
      preview: '...createSSEProxyHandler({ workerBase, lastEventId })...',
    },
    8900,
    400,
    91,
  ),

  // 8. t=9500 — streaming analysis
  ...streamedText(
    SESSION_ID,
    'Found it. The route handler uses `createSSEProxyHandler` with `lastEventId` passed as a query param to the Worker. Let me check the Worker side.',
    9500,
    4000,
    100,
  ),

  // 9. t=13500 — Read create-sse-proxy.ts
  toolStart(
    SESSION_ID,
    TOOL_READ_SSE_PROXY,
    'Read',
    { path: 'src/lib/api/create-sse-proxy.ts' },
    13500,
    130,
  ),

  // 10. t=14000 — tool-end
  toolEnd(
    SESSION_ID,
    TOOL_READ_SSE_PROXY,
    {
      lines: 95,
      preview: '...reconstructs SSE stream from Worker and forwards with original event IDs...',
    },
    14000,
    500,
    131,
  ),

  // 11. t=15000 — longer investigation text
  ...streamedText(
    SESSION_ID,
    "The proxy handler forwards SSE events verbatim from the Worker, preserving the original event IDs. This means the browser's EventSource lastEventId header is transparently carried through to the Worker. The Worker then replays missed events from the session log file starting after that ID. Let me confirm by checking the Worker SSE handler.",
    15000,
    9000,
    140,
  ),

  // 12. t=25000 — permission request for writing notes
  permissionRequest(
    SESSION_ID,
    'Write',
    'agent wants to write to `planning/reconnect-notes.md` with findings about the SSE reconnect architecture',
    25000,
    200,
  ),

  // 13. t=28000 — mode change: user approved → acceptEdits
  modeChange(SESSION_ID, 'default', 'acceptEdits', 28000, 201),

  // 14. t=30000 — Write tool start
  toolStart(
    SESSION_ID,
    TOOL_WRITE_NOTES,
    'Write',
    { path: 'planning/reconnect-notes.md', content: '# SSE Reconnect Architecture\n...' },
    30000,
    202,
  ),

  // 15. t=31000 — Write tool end
  toolEnd(SESSION_ID, TOOL_WRITE_NOTES, { success: true, bytesWritten: 1842 }, 31000, 1000, 203),

  // 16. t=32000 — Synthesis text spread over 40 seconds
  ...streamedText(
    SESSION_ID,
    [
      'The SSE architecture relies on three properties:\n\n',
      "**1. Monotonic sequence IDs**: Every event emitted by the Worker is assigned a monotonically increasing integer `id`. The browser's EventSource automatically tracks this in `lastEventId`.\n\n",
      '**2. Transparent proxy**: The Next.js route handler (`/api/sessions/:id/events`) proxies the Worker SSE stream without buffering, forwarding the original event IDs. On reconnect it passes `lastEventId` as a `?from=` query param.\n\n',
      '**3. Log-based replay**: The Worker log writer (`log-writer.ts`) appends every serialized event to a session-specific `.log` file. On reconnect (when `from` param is present), the Worker streams the log file from that position before attaching the live listener, bridging any gap.\n\n',
      "This design means the system is stateless from the browser's perspective — a page refresh or network hiccup replays everything missed, with zero DB reads.",
    ].join(''),
    32000,
    40000,
    210,
  ),

  // 17. t=72500 — agent:result (summary emitted as agent:text first, after streamedText ends at 72000)
  agentText(
    SESSION_ID,
    'Documented SSE reconnect architecture. Key insight: lastEventId is cross-process — client → Next route → Worker. Saved notes to planning/reconnect-notes.md.',
    72500,
    300,
  ),
  agentResult(
    SESSION_ID,
    'Documented SSE reconnect architecture. Key insight: lastEventId is cross-process — client → Next route → Worker. Saved notes to planning/reconnect-notes.md.',
    73000,
    301,
  ),

  // Arc ends at t=90000 — no session:end since status is 'running'
];
