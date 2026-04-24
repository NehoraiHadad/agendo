/**
 * Codex Refactor — 60-second "completed" arc.
 *
 * Story: Codex refactored `use-session-stream.ts` to use `lastEventId` for catchup.
 * Tests pass, typecheck clean. Session ends normally.
 *
 * Session ID: 88888888-8888-4888-a888-888888888888
 */

import {
  sessionStart,
  agentText,
  toolStart,
  toolEnd,
  agentResult,
  sessionEnd,
  streamedText,
  makeToolUseId,
  type ReplayableEvent,
} from '@/lib/demo/sse/factories';

const SESSION_ID = '88888888-8888-4888-a888-888888888888';

// Pre-generate toolUseIds so start/end pairs always match.
const TOOL_EDIT_HOOK = makeToolUseId(SESSION_ID);
const TOOL_BASH_VITEST = makeToolUseId(SESSION_ID);
const TOOL_BASH_TYPECHECK = makeToolUseId(SESSION_ID);

export const codexRefactorEvents: ReplayableEvent[] = [
  // 1. t=0 — session:init
  sessionStart(SESSION_ID, 0, 0),

  // 2. t=500 — streaming intro text
  ...streamedText(
    SESSION_ID,
    'Refactoring `use-session-stream.ts` to pass `lastEventId` in the URL so the server can replay missed events.',
    500,
    3000,
    10,
  ),

  // 3. t=4000 — Edit the hook file
  toolStart(
    SESSION_ID,
    TOOL_EDIT_HOOK,
    'Edit',
    {
      path: 'src/hooks/use-session-stream.ts',
      description:
        'Append lastEventId as ?from= query param when constructing EventSource URL for reconnect catchup',
    },
    4000,
    50,
  ),

  // 4. t=4400 — Edit done
  toolEnd(
    SESSION_ID,
    TOOL_EDIT_HOOK,
    {
      success: true,
      linesChanged: 12,
      diff:
        '-  const url = `/api/sessions/${sessionId}/events`;\n' +
        '+  const url = lastEventId\n' +
        '+    ? `/api/sessions/${sessionId}/events?from=${lastEventId}`\n' +
        '+    : `/api/sessions/${sessionId}/events`;',
    },
    4400,
    400,
    51,
  ),

  // 5. t=5000 — explain the diff
  ...streamedText(
    SESSION_ID,
    "The change is minimal: we check `lastEventId` (tracked by the browser's EventSource automatically) and append it as a `?from=` query parameter. The API route already passes this to the Worker, so catchup is now end-to-end.",
    5000,
    3000,
    60,
  ),

  // 6. t=8000 — Run tests
  toolStart(
    SESSION_ID,
    TOOL_BASH_VITEST,
    'Bash',
    { command: 'pnpm vitest run src/hooks/__tests__/use-session-stream.test.ts' },
    8000,
    90,
  ),

  // 7. t=12000 — tests pass
  toolEnd(
    SESSION_ID,
    TOOL_BASH_VITEST,
    {
      exitCode: 0,
      stdout:
        ' RUN  v3.2.4\n\n ✓ use-session-stream > connects without lastEventId (12ms)\n ✓ use-session-stream > appends ?from= on reconnect (8ms)\n ✓ use-session-stream > resets lastEventId on session change (5ms)\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)',
    },
    12000,
    4000,
    91,
  ),

  // 8. t=13000 — confirm and move to typecheck
  ...streamedText(
    SESSION_ID,
    'Tests pass. Let me also verify the API route still compiles.',
    13000,
    1000,
    100,
  ),

  // 9. t=14000 — Run typecheck
  toolStart(SESSION_ID, TOOL_BASH_TYPECHECK, 'Bash', { command: 'pnpm typecheck' }, 14000, 110),

  // 10. t=18000 — typecheck clean
  toolEnd(
    SESSION_ID,
    TOOL_BASH_TYPECHECK,
    {
      exitCode: 0,
      stdout: '\nFound 0 errors.\n',
    },
    18000,
    4000,
    111,
  ),

  // 11. t=19000 — summary text
  ...streamedText(
    SESSION_ID,
    'All clear. The refactor was a 12-line change to `use-session-stream.ts`: append `?from=${lastEventId}` to the EventSource URL when a previous event ID is known. This enables seamless catchup on reconnect without any backend changes — the proxy route and Worker already supported the `from` param.',
    19000,
    30000,
    120,
  ),

  // 12. t=50000 — agent:result (summary as agent:text first, then metrics)
  agentText(SESSION_ID, 'Refactor complete. 3 tests green, typecheck clean.', 49500, 200),
  agentResult(SESSION_ID, 'Refactor complete. 3 tests green, typecheck clean.', 50000, 201),

  // 13. t=55000 — session:end
  sessionEnd(SESSION_ID, 'completed', 55000, 202),
];
