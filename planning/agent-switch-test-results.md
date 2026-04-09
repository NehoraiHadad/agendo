# Agent Switch — Test Results (2026-04-09)

## Bug Fixed

`forkSessionToAgent` created the new session idle but never dispatched it.
When the user sent their first message, `message/route.ts` passed only the
user's message as `resumePrompt`, and `session-runner.ts` used
`prompt = resumePrompt ?? session.initialPrompt ?? ''` — so the extracted
context in `session.initialPrompt` was silently ignored. The new agent
received a bare message with zero context from the parent session.

**Fix**: Call `createAndEnqueueSession` (with `enqueueOpts: { resumePrompt:
initialPrompt }`) immediately after extracting context — the same pattern
used by `POST /api/sessions`. The worker now receives the full context as
`resumePrompt` on first start; `session.initialPrompt` stays in DB for the
`InitialPromptBanner` in the UI.

## Test

- **Source session**: Gemini CLI — `awaiting_input`, 20 turns
- **Target agent**: Claude Code
- **Context mode**: hybrid + additional instructions

### API Response

```json
{
  "data": {
    "sessionId": "e0b690e2-14bc-4163-b134-6dff9ded14f9",
    "agentId": "4af57358-71fd-4577-a758-0135539b26c5",
    "agentName": "Claude Code",
    "contextMeta": {
      "totalTurns": 20,
      "includedVerbatimTurns": 5,
      "summarizedTurns": 15,
      "estimatedTokens": 4637,
      "previousAgent": "Gemini CLI",
      "projectName": "agendo",
      "llmSummarized": true
    }
  }
}
```

### New Session Lifecycle

| Time           | Status                                                   |
| -------------- | -------------------------------------------------------- |
| t=0 (creation) | `active` — dispatched immediately                        |
| t=3s           | `awaiting_input` — Claude processed context and is ready |

### Claude's Response

> "I've received the context transfer from the Gemini CLI session. I have
> full context on: [...]"

Duration: 5843ms, cost: $0.1864

### Verified

- `session.initialPrompt` in DB: `## Conversation Context Transfer — Previous agent: Gemini CLI...` ✅
- Claude received AI-summarized context (15 older turns + 5 verbatim) ✅
- Session entered `awaiting_input` without any user trigger ✅

## Works for All Providers

Agent switch always uses `adapter.spawn()` — a fresh session with the
context block as the initial prompt. No native fork mechanisms are involved,
so the fix is provider-agnostic (Claude, Codex, Gemini, Copilot).
