# GitHub Copilot CLI — Integration Research

**Date**: 2026-03-08
**Purpose**: Evaluate GitHub Copilot CLI as a potential fourth agent provider in Agendo

## 1. Current State & Availability

GitHub Copilot CLI reached **general availability on 2026-02-25** for all paid Copilot subscribers. It is a standalone terminal-native coding agent — not just the old `gh copilot suggest/explain` wrapper.

### Installation

| Method       | Command                                            |
| ------------ | -------------------------------------------------- |
| Shell script | `curl -fsSL https://gh.io/copilot-install \| bash` |
| Homebrew     | `brew install copilot-cli`                         |
| npm          | `npm install -g @github/copilot`                   |
| WinGet       | `winget install GitHub.Copilot`                    |
| Standalone   | GitHub Releases binaries                           |

**Binary name**: `copilot`

The old `gh copilot` CLI extension is **deprecated and retired**. `gh copilot` now acts as a thin bridge to the standalone CLI.

## 2. Headless / Non-Interactive Mode

**Partially supported** — there are specific flags but the recommended approach is the SDK.

### CLI Flags

- `-p` / `--prompt <text>` — provide prompt directly (no interactive input)
- `--approve-all` — autonomous file modifications (no approval prompts)
- `--agent` — specialized agentic mode (requires `--prompt`)
- `--acp --stdio` — ACP server mode over stdin/stdout (preferred for programmatic use)

### Limitation

Simple stdin piping (`echo "prompt" | copilot`) is not the idiomatic pattern. GitHub recommends using the SDK for subprocess integration.

## 3. Protocols

### Primary: ACP (Agent Client Protocol)

Copilot CLI implements ACP — the same protocol Gemini uses. Public preview since 2026-01-28.

**Server modes**:

- **stdio**: `copilot --acp` — communicates via stdin/stdout using NDJSON (JSON-RPC 2.0)
- **TCP**: `copilot --acp --port 8080` — HTTP server on specified port

This is significant for Agendo because we already have ACP experience from `gemini-adapter.ts`.

### MCP Support

Full MCP support — both built-in and custom servers:

- **Built-in GitHub MCP server**: GitHub resource interactions, auto-authenticated
- **Custom MCP servers**: Configurable via `/mcp show|edit|delete` commands
- **Supported transports**: stdio, HTTP, SSE

### Legacy

`--headless --stdio` flags are deprecated (removed in v0.0.410+), replaced by `--acp --stdio`.

## 4. Subprocess Spawning & SDK

### Option A: Copilot SDK (Recommended)

```bash
npm install @github/copilot-sdk  # Node.js
```

```typescript
import { CopilotClient } from '@github/copilot-sdk/node';

const client = new CopilotClient();
const session = await client.createSession({
  workingDirectory: '/path/to/project',
});
await session.sendMessage({ text: 'Your prompt here' });
// Handle streaming updates...
await session.close();
```

The SDK:

- Manages CLI process lifecycle (no orphaned processes)
- Handles JSON-RPC communication
- Provides session management
- Supports custom tools and permission handlers
- Available for Node.js, Python, Go, .NET

### Option B: Raw ACP

Spawn `copilot --acp --stdio` and handle JSON-RPC 2.0 over NDJSON directly. This is what we do with Gemini's ACP already.

## 5. Tool Approvals & Permissions

**Defense-in-depth model** — every action requires explicit approval by default.

### Approval Targets

- File read/write/modify
- Command execution
- Directory access (per-directory)
- Tool usage

### Approval Modes

| Mode                      | Behavior                                       |
| ------------------------- | ---------------------------------------------- |
| **Interactive** (default) | Prompt for each action                         |
| **Plan Mode**             | Review → clarify → plan → execute              |
| **Autopilot Mode**        | Autonomous execution (pre-approved tools only) |

### Programmatic Approval

Via ACP, the server sends `session/request_permission` requests. The client responds with approval/denial. This matches the same pattern we handle in `gemini-adapter.ts`.

Approvals can be persisted — same path/tool won't re-prompt in future sessions.

## 6. Models

Copilot CLI supports **multiple model providers** (unique among the agents we support):

| Provider  | Models                                      |
| --------- | ------------------------------------------- |
| Anthropic | Claude Opus 4.6, Claude Sonnet 4.6          |
| OpenAI    | GPT-5.4, GPT-5.3-Codex, GPT-5 mini, GPT-4.1 |
| Google    | Gemini 3 Pro                                |

Model selection is per-session. This is interesting because Copilot is the only agent that offers models from all three major providers.

## 7. Agentic Features

### Specialized Agents

- **Explore Agent** — fast codebase analysis
- **Task Agent** — build automation, testing
- **Code Review Agent** — change review
- **Plan Agent** — implementation planning

### Modes

- **Plan Mode** — structured planning with user oversight
- **Autopilot Mode** — full autonomous execution
- **Fleet Mode** — multiple agents working in parallel

## 8. Architecture Implications for Agendo

### Adapter Strategy

Two viable approaches:

#### Approach A: SDK-Based Adapter (Recommended)

Create `copilot-sdk-adapter.ts` wrapping `@github/copilot-sdk`:

- SDK handles process lifecycle → no orphaned process issues
- Clean API for session management
- Built-in permission handler callbacks
- Similar to how `codex-app-server-adapter.ts` wraps Codex's JSON-RPC

**Pros**: Simpler, maintained by GitHub, handles edge cases
**Cons**: Additional npm dependency, abstraction layer we don't fully control

#### Approach B: Raw ACP Adapter

Create `copilot-acp-adapter.ts` spawning `copilot --acp --stdio`:

- Reuse patterns from `gemini-adapter.ts` (same ACP protocol)
- Direct control over the process
- No additional dependencies beyond the CLI binary

**Pros**: Consistent with Gemini adapter, full control, no SDK dependency
**Cons**: More code to maintain, must handle ACP edge cases ourselves

### Recommendation

**Start with Approach B (Raw ACP)** because:

1. We already have a working ACP implementation in `gemini-adapter.ts`
2. ACP is the same protocol — significant code reuse possible
3. No additional npm dependency
4. Consistent adapter pattern across Gemini and Copilot
5. We can always migrate to the SDK later if ACP maintenance becomes burdensome

### Event Mapping

ACP events from Copilot would map to `AgendoEventPayload` similarly to Gemini:

- `session/new` → session init
- `session/message` → `agent:text` / `agent:tool-start` / `agent:tool-end`
- `session/request_permission` → `agent:tool-approval`
- `session/completed` → `agent:result`

### Integration Checklist

1. **Agent registration**: Add Copilot agent to DB seed (binary: `copilot`, slug: `copilot-cli-1`)
2. **Adapter**: `copilot-acp-adapter.ts` (or `copilot-sdk-adapter.ts`)
3. **Event mapper**: `copilot-acp-event-mapper.ts`
4. **Adapter factory**: Route `copilot` binary to new adapter
5. **Model discovery**: Use ACP session config or CLI inspection
6. **Auto-discovery**: Detect `copilot` binary in PATH (`which copilot`)
7. **MCP injection**: Pass Agendo MCP server via `--mcp-server` flag or ACP config
8. **Authentication**: Copilot requires GitHub authentication (`copilot auth login`)

### Concerns

1. **Authentication**: Copilot requires a paid GitHub Copilot subscription + `gh auth`. Unlike Claude/Codex/Gemini which use API keys, Copilot uses GitHub OAuth. This may complicate headless server deployments.
2. **ACP maturity**: ACP support is in public preview (not GA). Protocol may change.
3. **Multi-model complexity**: Copilot's model selection adds UI/UX considerations we don't have with single-model agents.
4. **Fleet mode conflict**: Copilot's built-in multi-agent ("Fleet") may conflict with Agendo's own orchestration.

## 9. Comparison Matrix

| Aspect         | Claude          | Codex                 | Gemini                  | Copilot                  |
| -------------- | --------------- | --------------------- | ----------------------- | ------------------------ |
| Protocol       | stream-json     | app-server (JSON-RPC) | ACP                     | ACP                      |
| Headless       | `-p` print mode | `codex exec`          | `--approval-mode` flags | `--acp --stdio` / SDK    |
| MCP            | Full            | Limited               | Via ACP                 | Full (built-in + custom) |
| Models         | Claude only     | GPT only              | Gemini only             | Multi-provider           |
| Auth           | API key         | API key               | API key / OAuth         | GitHub OAuth             |
| Adapter effort | Done            | Done                  | Done                    | Medium (ACP reuse)       |

## 10. Verdict

**Feasibility: HIGH** — Copilot CLI is a viable fourth agent provider.

The ACP protocol overlap with Gemini makes integration straightforward. The main risks are authentication complexity (GitHub OAuth vs API keys) and ACP being in preview.

**Priority: MEDIUM** — Worth adding but not urgent. The three existing agents cover all major model providers already. Copilot's unique value is its multi-model support and GitHub-native integration (issues, PRs, etc. via built-in MCP).

**Recommended next step**: When ready to implement, create a spike task to build `copilot-acp-adapter.ts` reusing patterns from `gemini-adapter.ts`.
