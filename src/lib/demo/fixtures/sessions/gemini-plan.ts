/**
 * Gemini Plan — 45-second "blocked" arc.
 *
 * Story: Gemini drafted a plan for feature rollout and is awaiting user approval
 * to proceed with file writes. Arc ends without resolution — session is blocked.
 *
 * Session ID: 99999999-9999-4999-a999-999999999999
 */

import {
  sessionStart,
  toolStart,
  toolEnd,
  permissionRequest,
  streamedText,
  makeToolUseId,
  type ReplayableEvent,
} from '@/lib/demo/sse/factories';

const SESSION_ID = '99999999-9999-4999-a999-999999999999';

// Pre-generate toolUseIds.
const TOOL_READ_FEATURES = makeToolUseId(SESSION_ID);

export const geminiPlanEvents: ReplayableEvent[] = [
  // 1. t=0 — session:init
  sessionStart(SESSION_ID, 0, 0),

  // 2. t=500 — streaming intro
  ...streamedText(
    SESSION_ID,
    'Planning the rollout of the new feature flag system across 3 packages. Let me draft the plan first.',
    500,
    3000,
    10,
  ),

  // 3. t=4000 — Read features.md
  toolStart(
    SESSION_ID,
    TOOL_READ_FEATURES,
    'Read',
    { path: 'my-other-app/src/features.md' },
    4000,
    50,
  ),

  // 4. t=4300 — tool-end: file read
  toolEnd(
    SESSION_ID,
    TOOL_READ_FEATURES,
    {
      lines: 64,
      preview:
        '# Feature Flags\n\nCurrent flags: `new_dashboard`, `beta_search`, `collab_editing`...',
    },
    4300,
    300,
    51,
  ),

  // 5. t=5000 — long-form plan streaming (spread over ~35 seconds)
  ...streamedText(
    SESSION_ID,
    [
      'Here is the proposed rollout plan for the feature flag system across all three packages:\n\n',

      '## Phase 1: Core Infrastructure (Week 1)\n\n',
      '- **`@my-app/feature-flags`** — New shared package exporting `createFlagClient()`, `useFlag()` React hook, and `isFlagEnabled()` server helper.\n',
      '- Each flag has: `name`, `defaultValue`, `rolloutPercent` (0-100), `allowlist: string[]`, and `description`.\n',
      '- Flag resolution order: user allowlist → rollout percentage → default value.\n\n',

      '## Phase 2: Package Integration (Week 2)\n\n',
      '- **`my-other-app`** — Replace all manual `process.env.FEATURE_*` checks with `isFlagEnabled()`.\n',
      '- **`my-admin-app`** — Add the `/flags` admin page (toggle, set rollout %, manage allowlist).\n',
      '- **`my-api`** — Validate flag state at middleware layer before protected routes.\n\n',

      '## Phase 3: Migration & Cleanup (Week 3)\n\n',
      '- Audit all 47 existing feature env vars and migrate to flag definitions.\n',
      '- Remove legacy `FEATURE_*` env vars from all `.env.example` files.\n',
      '- Update CI to seed flags in test environments via a `flags.test.ts` fixture.\n\n',

      '## Risks & Mitigations\n\n',
      '- **Flag evaluation performance**: Cache resolved flag state per-request with a 30s TTL. Benchmark: < 0.5ms per evaluation.\n',
      '- **Rollout collision**: Two flags with overlapping rollout buckets could create confusing UX. Enforce via lint rule that `rolloutPercent` sums across related flags ≤ 100%.\n',
      '- **Test isolation**: Each unit test mounts a clean `FlagProvider` with explicit overrides — no global state.\n\n',

      "I'm ready to write the updated `features.md` with this plan. Please approve the file write.",
    ].join(''),
    5000,
    35000,
    60,
  ),

  // 6. t=40000 — permission request: blocked awaiting user input
  permissionRequest(
    SESSION_ID,
    'Write',
    'agent wants to write to `my-other-app/src/features.md` with the updated feature flag rollout plan',
    40000,
    200,
  ),

  // Arc ends at t=45000 — no resolution.
  // Session is blocked awaiting user approval for the Write tool.
];
