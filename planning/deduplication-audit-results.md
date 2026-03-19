# Codebase Deduplication Audit Results

Date: 2026-03-19

## Unified Top 10 — Ranked by Impact

| #   | Opportunity                                                                                                                                                                 | Layer   | Est. Lines Saved | Files       | Risk   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------- | ----------- | ------ |
| 1   | ACP Adapter Base Class — `interrupt()`, `launch()`, `initAndRun()`, `sendPrompt()`, `createTransportConnection()`, `getHistory()` duplicated across Gemini/Copilot/OpenCode | Worker  | ~300             | 6           | Medium |
| 2   | MCP Server CRUD + form + dialogs — near-identical 580/676 line files                                                                                                        | UI      | ~250             | 2           | Low    |
| 3   | API routes bypassing `withErrorBoundary` + inline error responses                                                                                                           | API     | ~80              | 9 locations | Low    |
| 4   | Usage service `fetchClaudeUsage`/`fetchOpenAIUsage`/`fetchGeminiUsage` — identical skeleton                                                                                 | Service | ~45              | 1           | Low    |
| 5   | `getById` TableMap covers only 3 of 8 eligible tables                                                                                                                       | Service | ~25              | 6           | Low    |
| 6   | `getAgentIcon` + `LUCIDE_ICONS` duplicated in 3 components                                                                                                                  | UI      | ~30              | 3           | Low    |
| 7   | `SessionStatus` config maps in 3 components with inconsistent labels                                                                                                        | UI      | ~40              | 3           | Low    |
| 8   | `ConfirmDeleteDialog` pattern repeated in 4 files                                                                                                                           | UI      | ~60              | 4           | Low    |
| 9   | Inline empty states bypassing shared `EmptyState` component                                                                                                                 | UI      | ~50              | 4           | Low    |
| 10  | `token-usage` routes duplicate `findMeasurePy` + `MEASURE_PY_PATHS`                                                                                                         | API     | ~15              | 2           | Low    |

## Refactoring Plan

### Phase A — Safe, high-value (items 3-10)

Low-risk refactors using existing utilities and patterns. Can run in parallel.

### Phase B — Complex, highest-value (items 1-2)

ACP adapter base class and MCP server CRUD hook extraction. Higher complexity, tested carefully.

## Detailed Findings

See individual audit outputs for file-level details:

- API routes audit: withErrorBoundary adoption, error class usage, route factory expansion
- Services audit: db-helpers.ts TableMap, buildFilters adoption, search type unification
- UI audit: MCP CRUD hook, agent icons, session status, empty states, delete dialogs
- Worker audit: AbstractAcpAdapter base class for 3 ACP adapters
