# Copilot CLI Adapter — Code Analysis & Integration Plan

**Date**: 2026-03-12
**Task**: Spike: Copilot CLI adapter — code analysis & integration plan
**Status**: Research complete — ready for implementation
**Binary probed**: `copilot` v1.0.4 (`@github/copilot` npm, installed at `/usr/bin/copilot`)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Adapter Code Analysis — Gemini Reuse](#2-adapter-code-analysis--gemini-reuse)
3. [Event Mapper Diff — Gemini ACP vs Copilot ACP](#3-event-mapper-diff--gemini-acp-vs-copilot-acp)
4. [adapter-factory.ts Changes](#4-adapter-factoryts-changes)
5. [Auto-Discovery — scanner.ts & presets.ts](#5-auto-discovery--scannerts--presetsts)
6. [MCP Injection](#6-mcp-injection)
7. [Model Discovery](#7-model-discovery)
8. [Auth Check](#8-auth-check)
9. [DB Seed](#9-db-seed)
10. [File-by-File Change List](#10-file-by-file-change-list)
11. [Key Risks](#11-key-risks)

---

## 1. Executive Summary

GitHub Copilot CLI uses the same **ACP (Agent Client Protocol)** as Gemini CLI. The
transport layer (`GeminiAcpTransport`), client handler (`GeminiClientHandler`), and event
mapper structure are **all directly reusable** with cosmetic renaming. Estimated unique code
to write: ~200 lines (vs ~480 lines for the Gemini adapter). The primary differences are:

| Aspect                  | Gemini                                  | Copilot                                                     |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------- |
| ACP launch flag         | `--experimental-acp`                    | `--acp`                                                     |
| Permission modes        | `--approval-mode yolo\|auto_edit\|plan` | `--yolo` / `--allow-all-tools` flags                        |
| MCP via ACP session/new | Works                                   | **Bug #1040 — env field silently ignored**                  |
| MCP workaround          | Not needed                              | `--additional-mcp-config '{"mcpServers":{…}}'` CLI flag     |
| Resume                  | `--resume <id>`                         | `--resume=<uuid>` (also creates new session with that UUID) |
| Model list              | Runtime (Gemini npm module)             | Static list in `--help` output (17 models, 3 providers)     |
| Auth                    | GOOGLE_API_KEY                          | COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN              |
| TOML commands           | Scans `~/.gemini/commands/`             | No TOML — uses AGENTS.md                                    |
| `setModel()`            | Process restart                         | ACP `unstable_setSessionModel` (in-place)                   |

---

## 2. Adapter Code Analysis — Gemini Reuse

### 2.1 `gemini-acp-transport.ts` — **Fully Reusable as-is**

`GeminiAcpTransport` contains zero Gemini-specific logic. Every method (`createConnection`,
`initialize`, `loadOrCreateSession`, `sendPrompt`) operates on the standard ACP SDK
`ClientSideConnection` from `@agentclientprotocol/sdk`. The class can be:

- **Option A**: Renamed to `AcpTransport` and shared (ideal long-term refactor).
- **Option B**: Imported as-is inside `copilot-adapter.ts` without any change (quickest path).

Recommended: **Option B** for the initial implementation. A follow-up refactor can extract
`AcpTransport` as a shared utility. The transport file has no `gemini`-specific imports or
strings — it only imports from `@agentclientprotocol/sdk` and `@/lib/worker/adapters/types`.

Lines that would need a name change if extracted: only the class name and logger string.

```ts
// gemini-acp-transport.ts line 6
const log = createLogger('gemini-acp-transport'); // → 'acp-transport'

// class GeminiAcpTransport  →  class AcpTransport
```

### 2.2 `gemini-client-handler.ts` — **Fully Reusable as-is**

`GeminiClientHandler` implements the ACP `Client` interface from the SDK. All four handler
methods (`requestPermission`, `sessionUpdate`, `readTextFile`, `writeTextFile`) are standard
ACP protocol — identical for Copilot. The internal tool-call tracking (`activeToolCalls` Set)
is protocol-agnostic.

The only Gemini coupling is the type annotation:

```ts
// line 13
import type { GeminiEvent } from '@/lib/worker/adapters/gemini-event-mapper';
// and the emitNdjson callback type: (event: GeminiEvent) => void
```

For Copilot, create `CopilotClientHandler` by copy-and-adapting with `CopilotEvent` type.
The implementation body is **100% identical** — only the generic type changes.

Alternatively, make `GeminiClientHandler` generic:

```ts
class AcpClientHandler<TEvent extends { type: string }> implements Client { ... }
```

This is the cleanest long-term fix but is scope-creep for this task.

### 2.3 `gemini-event-mapper.ts` — **Structurally Reusable, Namespace Change**

The event mapper defines a union type (`GeminiEvent`) and a `mapGeminiJsonToEvents()` switch
function. For Copilot:

- Copy the file to `copilot-event-mapper.ts`
- Rename `GeminiEvent` → `CopilotEvent`
- Rename all `gemini:*` type strings → `copilot:*`
- The switch cases and `AgendoEventPayload` mappings are **identical in structure**
- Drop the `gemini:commands` case (Copilot doesn't use `available_commands_update` in ACP)

One addition needed: the `gemini:turn-error` → `system:error` text currently says
`"Gemini turn failed: …"` — change to `"Copilot turn failed: …"`.

### 2.4 `gemini-adapter.ts` — **Structural Template, Several Key Differences**

The `GeminiAdapter` class is the primary template. Reusable structure:

- Class field declarations (`childProcess`, `transport`, `clientHandler`, `sessionId`,
  `currentTurn`, `lock`, `pendingImage`, `dataCallbacks`, `exitCallbacks`, `storedOpts`,
  `modelSwitching`, `activeToolCalls`)
- `spawn()` / `resume()` / `extractSessionId()` / `sendMessage()` methods — identical logic
- `interrupt()` — identical SIGINT → SIGTERM → SIGKILL escalation
- `isAlive()` — identical
- `mapJsonToEvents()` — delegate to `copilot-event-mapper.ts` instead
- `launch()` private method — identical structure, just calls `CopilotAdapter.buildArgs()`
- `initAndRun()` — almost identical, remove TOML command loading
- `sendPrompt()` — identical
- `emitNdjson()` — identical, remove the `gemini:commands` merging block

**Differences requiring new logic in `copilot-adapter.ts`:**

#### `buildArgs()` — Replace entirely

```ts
// Gemini buildArgs:
args = ['--experimental-acp'];
args.push('--approval-mode', 'yolo'); // bypassPermissions
args.push('--approval-mode', 'auto_edit'); // acceptEdits
args.push('--approval-mode', 'plan'); // plan
args.push('--allowed-mcp-server-names', ...names); // MCP filtering

// Copilot buildArgs:
args = ['--acp'];
args.push('--yolo'); // bypassPermissions / dontAsk
args.push('--allow-all-tools', '--allow-all-paths', '--allow-all-urls'); // acceptEdits (no exact equiv)
// plan mode: no CLI flag — use bypassPermissions + read-only prompt
args.push('--model', opts.model); // same as Gemini
args.push(`--resume=${opts.sessionId}`); // when sessionId provided — creates new session with that UUID
args.push('--no-auto-update'); // always add to prevent update prompts in CI
// MCP servers injected differently — see §6
```

Full mapping:

| Agendo permissionMode | Copilot flag(s)                                            |
| --------------------- | ---------------------------------------------------------- |
| `bypassPermissions`   | `--yolo`                                                   |
| `dontAsk`             | `--yolo`                                                   |
| `acceptEdits`         | `--allow-all-tools --allow-all-paths`                      |
| `default`             | _(no flags — Copilot prompts per tool)_                    |
| `plan`                | `--allow-all-tools --allow-all-paths` + read-only preamble |

> **Note on `plan` mode**: Copilot has no `--approval-mode plan` equivalent. The plan-mode
> simulation follows the Gemini pattern: `permissionMode: 'bypassPermissions'` with a
> read-only instruction preamble and `mcp__agendo__save_plan` tool as the plan capture
> mechanism. This is documented in `cross-agent-plan-mode.md`.

#### `setPermissionMode()` — Use ACP `setSessionMode`

Copilot exposes ACP `session/setMode`. The available mode IDs are advertised in the
`session/new` response (`result.availableModes`). Based on the CLI help, Copilot has
at minimum `"default"` and `"plan"` modes. The implementation should:

1. Call `conn.setSessionMode({ sessionId, modeId })` (same as Gemini)
2. Build a mode map once mode IDs are discovered from a live ACP session
3. Return `false` for unsupported modes

```ts
// Placeholder mapping — exact mode IDs to be verified from live session/new response
const modeMap: Record<string, string> = {
  default: 'default',
  bypassPermissions: 'autopilot', // to be confirmed
  acceptEdits: 'autoEdit', // to be confirmed
};
```

#### `setModel()` — Use `unstable_setSessionModel` (no restart needed)

Copilot supports `unstable_setSessionModel` (ACP experimental method). Unlike Gemini which
requires a full process kill-and-restart to switch models, Copilot can switch in-place:

```ts
async setModel(model: string): Promise<boolean> {
  const conn = this.transport.getConnection();
  if (!this.sessionId || !conn) return false;
  try {
    await (conn as any).unstable_setSessionModel({
      sessionId: this.sessionId,
      modelId: model,
    });
    return true;
  } catch {
    return false;
  }
}
```

This is a significant improvement over the Gemini process-restart approach.

#### `initAndRun()` — Remove TOML command loading

Gemini scans `~/.gemini/commands/` for TOML slash commands. Copilot uses `AGENTS.md` for
custom instructions (not slash commands). The `loadGeminiCustomCommands()` call and the
`customTomlCommands` field should be omitted entirely from `CopilotAdapter`.

---

## 3. Event Mapper Diff — Gemini ACP vs Copilot ACP

Both Gemini and Copilot implement the same ACP `Client` interface from
`@agentclientprotocol/sdk`. The `sessionUpdate` notifications use the same
`SessionNotification.update.sessionUpdate` discriminant string values. However there are
minor behavioral differences:

### 3.1 Events that are **identical**

| ACP sessionUpdate type | Handler logic                                           |
| ---------------------- | ------------------------------------------------------- |
| `agent_message_chunk`  | text delta → `copilot:text-delta`                       |
| `agent_thought_chunk`  | thinking delta → `copilot:thinking-delta`               |
| `tool_call`            | tool start (yolo/autopilot mode) → `copilot:tool-start` |
| `tool_call_update`     | tool end with result → `copilot:tool-end`               |
| `current_mode_update`  | mode change → `copilot:mode-change`                     |
| `usage_update`         | context window stats → `copilot:usage`                  |
| `plan`                 | plan entries → `copilot:plan`                           |

### 3.2 Events that **differ or need investigation**

| Event                            | Gemini                                                       | Copilot                                                                                  |
| -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `available_commands_update`      | Used — emits TOML-merged slash commands                      | **Not expected** — Copilot uses AGENTS.md, not slash commands. Safe to ignore.           |
| `requestPermission` option kinds | `allow_once`, `allow_always`, `reject_once`, `reject_always` | **Same** — ACP spec defines these. Confirmed same Zod schema in SDK.                     |
| `current_mode_update` modeIds    | `"default"`, `"autoEdit"`, `"yolo"`, `"plan"`                | Unknown — must be discovered from live `session/new` response. Placeholder mapping only. |

### 3.3 Copilot-specific events (anticipated)

Copilot may send extension ACP notifications (via `extNotification`) for Copilot-specific
features like background delegation status or fleet coordination. These can be handled with a
`default` case in the event mapper (no-op) until documentation clarifies the payload.

### 3.4 `requestPermission` — behavior difference

In Gemini's default permission mode, the `requestPermission` call requires a response before
the agent continues. Copilot behaves identically per ACP spec. The `GeminiClientHandler`
approval flow maps directly to Copilot:

- `allow` → `allow_once` optionId
- `allow-session` → `allow_always` optionId
- `deny` → `reject_once` optionId

No changes needed.

### 3.5 `turn-complete` vs `turn-error` result shape

`gemini:turn-complete` carries a `result` object with `usage.inputTokens/outputTokens`.
Copilot's ACP `session/prompt` response should carry the same `usage` field per ACP spec.
Map identically. If Copilot omits the `usage` field, the fallback `costUsd: null` path
handles it gracefully.

---

## 4. `adapter-factory.ts` Changes

**File**: `src/lib/worker/adapters/adapter-factory.ts`

Single change — add `copilot` to the `ADAPTER_MAP`:

```ts
import { CopilotAdapter } from '@/lib/worker/adapters/copilot-adapter';

const ADAPTER_MAP: Record<string, new () => AgentAdapter> = {
  claude: ClaudeSdkAdapter,
  codex: CodexAppServerAdapter,
  gemini: GeminiAdapter,
  copilot: CopilotAdapter, // ← ADD
};
```

`getBinaryName(agent)` returns `"copilot"` for agents with `binaryPath` ending in `copilot`,
so no changes to `agent-utils.ts` are needed.

---

## 5. Auto-Discovery — `scanner.ts` & `presets.ts`

### 5.1 `scanner.ts` — No changes

`scanPATH()` is binary-agnostic. It scans all executables in `$PATH` and returns them. Since
`copilot` is now installed at `/usr/bin/copilot`, it will appear in the scan results
automatically. No changes needed.

**Probe result**:

```
which copilot → /usr/bin/copilot   (confirmed installed after: sudo npm install -g @github/copilot)
```

### 5.2 `presets.ts` — Add `copilot` entry

**File**: `src/lib/discovery/presets.ts`

Add to `AI_TOOL_PRESETS`:

```ts
copilot: {
  binaryName: 'copilot',
  displayName: 'GitHub Copilot CLI',
  kind: 'builtin',
  toolType: 'ai-agent',
  discoveryMethod: 'preset',
  envAllowlist: ['GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GH_HOST'],
  maxConcurrent: 1,
  mcpEnabled: true,
  sessionConfig: {
    sessionIdSource: 'acp',           // ACP session/new response contains sessionId
    resumeFlags: ['--resume={{sessionRef}}'],
    continueFlags: ['--continue'],
    bidirectionalProtocol: 'acp',
  },
  metadata: {
    icon: 'github',
    color: '#6B7280',
    description: 'GitHub Copilot CLI — AI coding assistant with multi-provider model support',
    homepage: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  },
},
```

**Note on `sessionConfig.sessionIdSource`**: The `"acp"` value is already used by the Gemini
preset (the `sessionIdSource` field may need to be added if it doesn't already exist in
`AgentSessionConfig`). The session ID comes from the ACP `session/new` response
(`result.sessionId`), which is captured via `this.sessionRefCallback` in the adapter.

**Bonus session ID trick**: Copilot's `--resume=<uuid>` flag creates a new session with
**that exact UUID** if the session doesn't exist yet. This means we can pass Agendo's own
session UUID as the Copilot session ID, eliminating the ID mapping layer entirely:

```ts
// In buildArgs():
if (opts.sessionId) {
  args.push(`--resume=${opts.sessionId}`);
}
```

This is cleaner than Gemini where ACP `session/new` assigns a random ID that we must store
and track separately.

### 5.3 `discovery/index.ts` — No changes

`runDiscovery()` already filters by `AI_TOOL_PRESETS` keys. Adding `copilot` to presets is
sufficient.

---

## 6. MCP Injection

### 6.1 The Bug

GitHub Copilot CLI ACP issue **#1040** (filed against `github/copilot-cli`): When starting
with `--acp`, the `mcpCapabilities` field is missing from the agent's ACP `initialize`
response. As a result, the `mcpServers` array in `session/new` is silently ignored — MCP
servers never start. The bug was present in v0.0.389 and has not been confirmed fixed as of
v1.0.4.

**Verification approach**: After spawn, log the `initResult.agentCapabilities` and check
whether `mcpCapabilities` is present. If missing, fall back to the CLI flag path.

### 6.2 Primary Strategy: `--additional-mcp-config` CLI flag

Copilot accepts `--additional-mcp-config` with an inline JSON string or `@file.json`:

```bash
copilot --acp \
  --additional-mcp-config '{"mcpServers":{"agendo":{"command":"node","args":["..."],"env":{"AGENDO_URL":"http://..."}}}}'
```

The JSON format for `--additional-mcp-config`:

```ts
interface CopilotMcpConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      type?: 'stdio'; // optional, defaults to stdio
      env?: Record<string, string>; // NOTE: plain object, NOT array-of-{name,value}
      cwd?: string;
      tools?: string[]; // e.g. ["*"] for all tools
    }
  >;
}
```

**Critical difference from ACP session/new format**: The Agendo `AcpMcpServer` type stores
`env` as `Array<{ name: string; value: string }>` (matching the ACP spec's `zEnvVariable`).
The `--additional-mcp-config` JSON expects `env` as a plain `Record<string, string>`.

Conversion needed in `buildArgs()`:

```ts
function buildMcpConfigFlag(mcpServers: AcpMcpServer[]): string {
  const config: Record<string, unknown> = {};
  for (const srv of mcpServers) {
    config[srv.name] = {
      command: srv.command,
      args: srv.args,
      // Convert [{name:'X',value:'V'}] → {'X':'V'}
      env: Object.fromEntries(srv.env.map(({ name, value }) => [name, value])),
    };
  }
  return JSON.stringify({ mcpServers: config });
}

// In buildArgs():
if (opts.mcpServers?.length) {
  args.push('--additional-mcp-config', buildMcpConfigFlag(opts.mcpServers));
}
```

### 6.3 Fallback Strategy: ACP `session/new` mcpServers

Once bug #1040 is confirmed fixed, we can also pass `mcpServers` in `loadOrCreateSession()`
as a secondary mechanism. The `GeminiAcpTransport.loadOrCreateSession()` already handles
this. Use both paths in parallel for defense in depth:

```ts
// copilot-adapter.ts – initAndRun():
// 1. CLI flag injects MCP servers at process start (workaround for bug #1040)
// 2. ACP session/new also passes mcpServers (works when bug is fixed)
```

### 6.4 MCP server filtering

Gemini uses `--allowed-mcp-server-names` to restrict which globally configured MCP servers
the process can see. Copilot has:

- `--disable-mcp-server <name>` — disable a specific server
- `--disable-builtin-mcps` — disable the built-in GitHub MCP server
- No equivalent allowlist flag

**Recommendation**: Always pass `--disable-builtin-mcps` in Agendo-managed sessions to
prevent the bundled GitHub MCP server from conflicting with our injected Agendo MCP server.
This avoids tool name collisions and unintended GitHub API access.

```ts
// In buildArgs():
args.push('--disable-builtin-mcps');
```

If the user explicitly wants GitHub MCP tools, they can add a capability flag later.

---

## 7. Model Discovery

### 7.1 Method: Static list from `--help` output

Copilot has no `copilot model list` command. Models are listed as explicit `--model` choices
in `--help`. The full list as of v1.0.4:

```
claude-sonnet-4.6   claude-sonnet-4.5   claude-haiku-4.5
claude-opus-4.6     claude-opus-4.6-fast claude-opus-4.5  claude-sonnet-4
gemini-3-pro-preview
gpt-5.4  gpt-5.3-codex  gpt-5.2-codex  gpt-5.2
gpt-5.1-codex-max  gpt-5.1-codex  gpt-5.1  gpt-5.1-codex-mini
gpt-5-mini  gpt-4.1
```

### 7.2 Integration with discovery pipeline

The existing `quickParseHelp()` function in `discovery/schema-extractor.ts` parses `--help`
output and extracts flag options. Since `--model` lists choices explicitly, the model list
will be captured automatically by the discovery pipeline when `copilot` is in `presets.ts`.

### 7.3 Comparison with other agents

| Agent       | Method                                     | Dynamic?            |
| ----------- | ------------------------------------------ | ------------------- |
| Claude      | `strings` binary + grep (labels only)      | No                  |
| Codex       | `codex app-server` JSON-RPC `model/list`   | Yes                 |
| Gemini      | `require()` from `@google/gemini-cli-core` | Quasi-static        |
| **Copilot** | `--help` choices list                      | No (version-pinned) |

The static list approach is fine — model names change rarely and will be refreshed when
`pnpm db:seed` is re-run after a `copilot update`.

### 7.4 Default model

The `--help` output doesn't mark a default. Based on the research, the default at GA is
`claude-sonnet-4.6`. Hardcode this as the preset default in the capability seed entry.

---

## 8. Auth Check

### 8.1 Token chain (from `copilot help environment`)

Copilot checks these in order:

1. `COPILOT_GITHUB_TOKEN` env var
2. `GH_TOKEN` env var
3. `GITHUB_TOKEN` env var
4. Stored credential from `copilot login` (in `~/.copilot/` or system keychain)

### 8.2 Auth verification strategy

**Option A**: Run `gh auth status 2>&1` before spawning. Exit code 0 means authenticated.
This is fast (<100ms) and already available since `gh` is installed.

**Option B**: Check `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` env vars directly.
If any is set, proceed. No subprocess needed.

**Option C**: Check `~/.copilot/` for a stored token file (brittle — depends on file format).

**Recommendation**: **Option B** as the primary check, **Option A** as fallback:

```ts
// In a future copilot-auth.ts helper:
export function isCopilotAuthAvailable(env: Record<string, string>): boolean {
  return !!(env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN);
}
```

For headless server deployments: set `GITHUB_TOKEN` (a fine-grained PAT with "Copilot
Requests" permission) or `GH_TOKEN`. Classic `ghp_` PATs are **not** supported.

### 8.3 Pre-spawn check in adapter

Add a check in `CopilotAdapter.spawn()` that emits a `system:error` event if no auth is
available rather than silently hanging:

```ts
spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
  const hasAuth = opts.env.COPILOT_GITHUB_TOKEN || opts.env.GH_TOKEN || opts.env.GITHUB_TOKEN;
  if (!hasAuth) {
    // Check stored credentials — spawn `copilot --version` and if it exits 1 → emit error
    // (or just trust that the login flow handled it)
  }
  return this.launch(prompt, opts, null);
}
```

In practice, if the agent row in DB has `envAllowlist: ['GITHUB_TOKEN', 'GH_TOKEN',
'COPILOT_GITHUB_TOKEN']`, and the worker's `ecosystem.config.js` sets one of these, auth
will flow through automatically.

---

## 9. DB Seed

### 9.1 Automatic seeding via discovery

With `copilot` added to `AI_TOOL_PRESETS` in `presets.ts`, running `pnpm db:seed` will
automatically discover and register the Copilot agent. No manual SQL needed for standard
installs.

### 9.2 Manual seed (if running db:seed before install or for testing)

**Agent row**:

```sql
INSERT INTO agents (
  id, name, slug, binary_path, kind, tool_type,
  mcp_enabled, max_concurrent, env_allowlist, metadata, session_config
) VALUES (
  gen_random_uuid(),
  'GitHub Copilot CLI',
  'copilot-cli-1',
  '/usr/bin/copilot',
  'builtin',
  'ai-agent',
  true,
  1,
  '["GITHUB_TOKEN","COPILOT_GITHUB_TOKEN","GH_TOKEN","GH_HOST"]',
  '{
    "icon": "github",
    "color": "#6B7280",
    "description": "GitHub Copilot CLI — AI coding assistant with multi-provider model support",
    "homepage": "https://docs.github.com/copilot/how-tos/copilot-cli"
  }',
  '{
    "sessionIdSource": "acp",
    "resumeFlags": ["--resume={{sessionRef}}"],
    "continueFlags": ["--continue"],
    "bidirectionalProtocol": "acp"
  }'
) ON CONFLICT (slug) DO NOTHING;
```

**Capability row** (prompt-mode, replaces the old `promptCapability`):

```sql
-- Get the agent ID first, then:
INSERT INTO capabilities (
  id, agent_id, name, slug, kind, description, config
) VALUES (
  gen_random_uuid(),
  '<agent-id-from-above>',
  'GitHub Copilot Chat',
  'copilot-chat-1',
  'prompt',
  'Interactive coding agent session with GitHub Copilot CLI',
  '{
    "defaultModel": "claude-sonnet-4.6",
    "availableModels": [
      "claude-sonnet-4.6", "claude-sonnet-4.5", "claude-haiku-4.5",
      "claude-opus-4.6", "claude-opus-4.6-fast", "claude-opus-4.5", "claude-sonnet-4",
      "gemini-3-pro-preview",
      "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2",
      "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1", "gpt-5.1-codex-mini",
      "gpt-5-mini", "gpt-4.1"
    ]
  }'
) ON CONFLICT (slug) DO NOTHING;
```

### 9.3 Agent slug convention

Following existing pattern: `claude-code-1`, `codex-cli-1`, `gemini-cli-1` → `copilot-cli-1`.

---

## 10. File-by-File Change List

### New files (create)

| File                                                | Lines (est.) | Notes                                                                                                                                                         |
| --------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/worker/adapters/copilot-adapter.ts`        | ~200         | Main adapter class. Structural copy of `gemini-adapter.ts` with `buildArgs()` replaced, `setModel()` using ACP in-place switch, TOML command loading removed. |
| `src/lib/worker/adapters/copilot-event-mapper.ts`   | ~100         | Copy of `gemini-event-mapper.ts`. Rename `GeminiEvent` → `CopilotEvent`, all `gemini:*` → `copilot:*`. Drop `copilot:commands` case.                          |
| `src/lib/worker/adapters/copilot-client-handler.ts` | ~80          | Copy of `gemini-client-handler.ts`. Change `GeminiEvent` import to `CopilotEvent`. Body unchanged.                                                            |

### Modified files

| File                                              | Change                                                       | Complexity         |
| ------------------------------------------------- | ------------------------------------------------------------ | ------------------ |
| `src/lib/worker/adapters/adapter-factory.ts`      | Add `copilot: CopilotAdapter` to `ADAPTER_MAP`               | Trivial (2 lines)  |
| `src/lib/discovery/presets.ts`                    | Add `copilot` entry to `AI_TOOL_PRESETS`                     | Simple (~25 lines) |
| `src/lib/worker/session-preambles.ts`             | Add `copilot` branch in `generatePlanConversationPreamble()` | Simple (~15 lines) |
| `src/lib/worker/adapters/types.ts`                | No changes required                                          | —                  |
| `src/lib/worker/adapters/gemini-acp-transport.ts` | No changes (reused as-is or renamed later)                   | —                  |

### No changes needed

- `scanner.ts` — binary-agnostic
- `base-adapter.ts` — abstract base, unchanged
- `session-runner.ts` — adapter-agnostic
- `session-process.ts` — adapter-agnostic
- `seed.ts` — uses `runDiscovery()` which picks up presets automatically
- DB migrations — no schema changes needed

### Test files (optional but recommended)

| File                                                             | Notes                                        |
| ---------------------------------------------------------------- | -------------------------------------------- |
| `src/lib/worker/adapters/__tests__/copilot-adapter.test.ts`      | Mirror of `gemini-adapter.test.ts` structure |
| `src/lib/worker/adapters/__tests__/copilot-event-mapper.test.ts` | Mirror of `gemini-event-mapper.test.ts`      |

---

## 11. Key Risks

### Risk 1: ACP MCP bug #1040 (HIGH impact, MEDIUM probability of being fixed)

- **Issue**: MCP servers passed in `session/new` may be silently ignored.
- **Mitigation**: Use `--additional-mcp-config` CLI flag as primary injection path (§6.2).
  Pass `mcpServers` in `session/new` as well for when bug is fixed.
- **Verification**: Log `initResult.agentCapabilities.mcpCapabilities` on first start.

### Risk 2: ACP mode IDs for `setPermissionMode()` (LOW impact, HIGH probability)

- **Issue**: Copilot's ACP `availableModes` IDs are unknown without a live session. The
  `setPermissionMode()` method may return `false` until mode IDs are confirmed.
- **Mitigation**: Use `--yolo`/`--allow-all-tools` CLI flags at spawn time (which is
  sufficient for `bypassPermissions`). In-session mode switching is a nice-to-have.

### Risk 3: Auth in headless server environments (HIGH impact, LOW probability)

- **Issue**: Copilot requires a GitHub PAT (fine-grained, "Copilot Requests" permission).
  Classic `ghp_` tokens are rejected. Service accounts may not have Copilot subscriptions.
- **Mitigation**: Document the `GITHUB_TOKEN` requirement in agent setup instructions.
  Generate a fine-grained PAT from the user's GitHub account (not a machine account).

### Risk 4: NDJSON framing differences (LOW impact, LOW probability)

- **Issue**: If Copilot uses `Content-Length` framing instead of NDJSON for some messages.
- **Current status**: `copilot --acp` documented as NDJSON on stdio.
- **Mitigation**: `ndJsonStream` from `@agentclientprotocol/sdk` handles this automatically.

### Risk 5: Built-in GitHub MCP server tool conflicts (MEDIUM impact, MEDIUM probability)

- **Issue**: Copilot bundles a GitHub MCP server by default. Its tool names may collide with
  Agendo's MCP tool names, or it may perform unexpected GitHub API calls.
- **Mitigation**: Always pass `--disable-builtin-mcps` in `buildArgs()` (§6.4).

---

## Appendix: Copilot CLI ACP Flags Reference

```
copilot --acp                           # Start as ACP server (stdio, NDJSON)
copilot --acp --port 3000               # TCP mode (not needed for Agendo)
copilot --acp --yolo                    # bypassPermissions
copilot --acp --allow-all-tools         # Allow tools without prompt
copilot --acp --allow-all-paths         # Allow any file path
copilot --acp --allow-all              # Combined (tools + paths + URLs)
copilot --acp --model claude-sonnet-4.6 # Model selection
copilot --acp --resume=<uuid>           # Resume or create session with given UUID
copilot --acp --continue                # Resume most recent session
copilot --acp --no-auto-update         # Disable update check (for CI/server)
copilot --acp --disable-builtin-mcps   # Disable bundled GitHub MCP server
copilot --acp --additional-mcp-config '{"mcpServers":{…}}'  # Inject MCP servers
copilot --acp --no-custom-instructions  # Disable AGENTS.md loading (optional)
```

**Environment variables**:

```
COPILOT_GITHUB_TOKEN   # Auth token (highest priority)
GH_TOKEN               # GitHub CLI auth token
GITHUB_TOKEN           # Standard GitHub token
COPILOT_ALLOW_ALL      # "true" = bypass all permissions
COPILOT_MODEL          # Default model (overridden by --model)
GH_HOST                # GitHub Enterprise hostname
```
