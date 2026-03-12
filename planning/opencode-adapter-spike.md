# OpenCode CLI Adapter — Code Analysis & Integration Plan

**Date**: 2026-03-12
**Task**: Spike: OpenCode CLI adapter — code analysis & integration plan
**Status**: Research complete — ready for implementation
**Binary probed**: `opencode` v1.2.24 (`opencode-ai` npm, installed at `/usr/bin/opencode`)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Installation & Binary](#2-installation--binary)
3. [Protocol Analysis — The Server Mode](#3-protocol-analysis--the-server-mode)
4. [Adapter Code Analysis — Reuse Potential](#4-adapter-code-analysis--reuse-potential)
5. [Event Mapper Diff](#5-event-mapper-diff)
6. [adapter-factory.ts Changes](#6-adapter-factoryts-changes)
7. [Auto-Discovery — scanner.ts & presets.ts](#7-auto-discovery--scannerts--presetsts)
8. [MCP Injection](#8-mcp-injection)
9. [Model Discovery](#9-model-discovery)
10. [Auth & Multi-Provider Config](#10-auth--multi-provider-config)
11. [Permission / Approval Model](#11-permission--approval-model)
12. [Session Resume](#12-session-resume)
13. [DB Seed](#13-db-seed)
14. [File-by-File Change List](#14-file-by-file-change-list)
15. [Key Risks](#15-key-risks)

---

## 1. Executive Summary

OpenCode uses **ACP (Agent Client Protocol) over stdio** for its integration mode (`opencode acp`).
This is confirmed directly from the source code (`packages/opencode/src/cli/cmd/acp.ts`):

```typescript
const stream = ndJsonStream(input, output); // input=stdout, output=stdin
new AgentSideConnection((conn) => agent.create(conn, { sdk }), stream);
```

This is **architecturally identical** to Gemini and Copilot. The `AcpTransport` class (formerly
`GeminiAcpTransport`) is fully reusable. The `CopilotAdapter` is the primary implementation template.

**Protocol Verdict: ACP / NDJSON stdio — confidence 100%** (confirmed from source, not inferred).

**Reuse summary:**

| Existing file                              | Reuse status    | Notes                                                    |
| ------------------------------------------ | --------------- | -------------------------------------------------------- |
| `gemini-acp-transport.ts` (`AcpTransport`) | As-is           | Zero changes needed                                      |
| `gemini-client-handler.ts`                 | Structural copy | Change `gemini:` to `opencode:` event prefixes only      |
| `gemini-event-mapper.ts`                   | Structural copy | Change `gemini:` to `opencode:` event prefixes only      |
| `copilot-adapter.ts`                       | Best template   | `buildArgs()` fully replaced; perm mode approach differs |
| `base-adapter.ts`                          | As-is           | No changes                                               |
| `adapter-factory.ts`                       | Trivial change  | Add `opencode: OpenCodeAdapter`                          |
| `presets.ts`                               | Additive        | Add `opencode` preset                                    |

Estimated unique code to write: **~250 lines** (vs ~480 for Gemini, ~200 for Copilot).

**Key differences from Gemini/Copilot:**

| Aspect               | Gemini                                | Copilot                    | OpenCode                                                                   |
| -------------------- | ------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| ACP launch           | `gemini --experimental-acp`           | `copilot --acp`            | `opencode acp` (subcommand!)                                               |
| Working directory    | process `cwd` option                  | process `cwd` option       | `--cwd` CLI flag required                                                  |
| Permission bypass    | `--approval-mode yolo`                | `--yolo`                   | `OPENCODE_CONFIG_CONTENT` env var                                          |
| Permission optionIds | `allow_once/allow_always/reject_once` | same                       | `once/always/reject` (kind-based lookup compatible, no code change needed) |
| Model format         | `model-name`                          | `model-name`               | `provider/model` (e.g. `anthropic/claude-sonnet-4-5`)                      |
| setModel()           | Process restart                       | `unstable_setSessionModel` | Standard `setSessionModel` (stable ACP)                                    |
| MCP injection        | ACP `session/new`                     | CLI flag + ACP             | ACP `session/new` (confirmed in source)                                    |
| Mode IDs             | `default/autoEdit/yolo/plan`          | `default/autopilot/...`    | Agent names: `plan/build/general/explore`                                  |
| Slash commands       | TOML files                            | AGENTS.md                  | None (OpenCode uses agents, not slash commands)                            |
| Session storage      | ACP-managed                           | ACP-managed                | SQLite `~/.local/share/opencode/opencode.db`                               |

---

## 2. Installation & Binary

### 2.1 Installation

```bash
sudo npm install -g opencode-ai
which opencode  # /usr/bin/opencode
opencode --version  # 1.2.24
```

The `opencode-ai` npm package is a thin launcher (`bin/opencode` is a 4.5KB Node.js script)
that resolves the platform-specific pre-compiled Bun binary from optional dependencies
(`opencode-linux-x64`, `opencode-linux-x64-baseline`, etc.). The actual binary is a
self-contained Bun executable — no JS source is accessible from the npm package.

### 2.2 Binary path and binaryName

```
/usr/bin/opencode -> /usr/lib/node_modules/opencode-ai/bin/opencode
```

**`binaryName`**: `opencode`

### 2.3 Full help output (abridged)

```
Commands:
  opencode acp                 start ACP (Agent Client Protocol) server
  opencode mcp                 manage MCP servers
  opencode run [message..]     run opencode with a message
  opencode auth                manage credentials
  opencode serve               starts a headless opencode server
  opencode models [provider]   list all available models
  opencode session             manage sessions
  opencode export [sessionID]  export session data as JSON
  opencode import <file>       import session data from JSON/URL

Options:
  --print-logs        print logs to stderr
  --log-level         DEBUG|INFO|WARN|ERROR
  --port              port to listen on [default: 0]
  --hostname          hostname [default: "127.0.0.1"]
  -m, --model         model to use (provider/model format)
  -c, --continue      continue the last session
  -s, --session       session id to continue
  --fork              fork the session
  --agent             agent to use
```

---

## 3. Protocol Analysis — The Server Mode

### 3.1 ACP Mode (`opencode acp`)

The `opencode acp` subcommand is the headless integration interface. From the source
(`packages/opencode/src/cli/cmd/acp.ts`):

```typescript
// input = WritableStream wrapping process.stdout
// output = ReadableStream wrapping process.stdin
const stream = ndJsonStream(input, output);
const agent = await ACP.init({ sdk });
new AgentSideConnection((conn) => agent.create(conn, { sdk }), stream);
```

Key facts:

- **Transport**: NDJSON over **stdio** (identical to Gemini and Copilot)
- **Client writes** ACP commands to opencode's **stdin**
- **Client reads** ACP events from opencode's **stdout**
- `--print-logs` redirects OpenCode's structured logs to **stderr** (safe to forward to
  Agendo's dataCallbacks without conflicting with ACP protocol)
- The `--port` / `--hostname` / `--mdns` flags on `opencode acp` control an **internal HTTP
  server** that OpenCode's ACP layer uses to connect to its own core — NOT the ACP transport.
  From Agendo's perspective these flags are irrelevant; ACP runs on stdio.

### 3.2 `opencode acp --help` flags

```
opencode acp

start ACP (Agent Client Protocol) server

Options:
  --print-logs    print logs to stderr
  --log-level     DEBUG|INFO|WARN|ERROR
  --port          port to listen on [default: 0]
  --hostname      hostname [default: "127.0.0.1"]
  --mdns          enable mDNS discovery
  --cors          additional CORS domains
  --cwd           working directory [default: process.cwd()]
```

**`--cwd` is critical** — unlike Gemini and Copilot which use the process working directory
inherited via `spawnDetached(binary, args, { cwd })`, OpenCode's `acp` subcommand requires
the working directory to be passed as an **explicit CLI flag**. The `cwd` spawn option
still sets the process working directory as a fallback, but `--cwd` must be passed for
OpenCode to correctly set the project context.

### 3.3 ACP Initialize response

From `packages/opencode/src/acp/agent.ts`, OpenCode's `initialize()` advertises:

```typescript
{
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { fork: true, list: true, resume: true },
  },
}
```

This means:

- `session/resume` supported (`unstable_resumeSession`)
- `session/load` supported (`loadSession`)
- `session/new` with `mcpServers` supported (`mcpCapabilities` is present — no Copilot bug #1040 equivalent)
- Image prompts supported (`promptCapabilities.image`)
- Session fork supported

### 3.4 Comparison with existing protocols

| Feature        | Codex app-server          | Gemini ACP              | Copilot ACP             | OpenCode ACP            |
| -------------- | ------------------------- | ----------------------- | ----------------------- | ----------------------- |
| Transport      | NDJSON stdio              | NDJSON stdio            | NDJSON stdio            | NDJSON stdio            |
| SDK            | `NdjsonRpcTransport`      | `AcpTransport`          | `AcpTransport`          | `AcpTransport`          |
| Session resume | `thread/resume`           | `session/resume`        | `--resume=<uuid>`       | `session/resume`        |
| MCP injection  | `config/batchWrite`       | `session/new`           | CLI flag                | `session/new`           |
| Approval flow  | JSON-RPC server-to-client | ACP `requestPermission` | ACP `requestPermission` | ACP `requestPermission` |

---

## 4. Adapter Code Analysis — Reuse Potential

### 4.1 `gemini-acp-transport.ts` (`AcpTransport`) — Fully Reusable As-Is

Zero changes needed. The `AcpTransport` class is protocol-level agnostic: it wraps any
stdin/stdout as a `ClientSideConnection` and handles `initialize`, `loadOrCreateSession`,
and `sendPrompt`. OpenCode's ACP uses the same `@agentclientprotocol/sdk` package.

### 4.2 `gemini-client-handler.ts` — Structural Copy, Prefix Change Only

The `GeminiClientHandler` logic is fully compatible with OpenCode. The critical concern was
the `requestPermission` option IDs:

OpenCode sends:

```typescript
this.permissionOptions = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
];
```

The client handler finds options by `kind` (not `optionId`):

```typescript
options.find((o) => o.kind === 'allow_always'); // -> { optionId: "always", kind: "allow_always" }
options.find((o) => o.kind === 'allow_once'); // -> { optionId: "once",   kind: "allow_once" }
options.find((o) => o.kind === 'reject_once'); // -> { optionId: "reject", kind: "reject_once" }
```

**The handler returns `chosenOption.optionId`** — so it returns `"always"`, `"once"`, or
`"reject"` to OpenCode, which is exactly what OpenCode expects. **No logic change needed.**

The only change is the event type prefix (`gemini:` to `opencode:`) in `emitNdjson` calls.

Create `opencode-client-handler.ts` as a copy of `gemini-client-handler.ts` with:

- `GeminiClientHandler` renamed to `OpenCodeClientHandler`
- `GeminiEvent` import changed to `OpenCodeEvent`
- All `gemini:` string prefixes changed to `opencode:`

### 4.3 `gemini-event-mapper.ts` — Structural Copy, Prefix Change Only

OpenCode's ACP emits the same `sessionUpdate` types as Gemini (standard ACP protocol):

- `agent_message_chunk` — text streaming
- `agent_thought_chunk` — thinking streaming
- `tool_call` — tool started
- `tool_call_update` — tool completed/failed
- `usage_update` — token usage
- `plan` — plan entries (from TodoWrite tool)
- `current_mode_update` — agent mode changed

**No behavioral differences from Gemini** at the `sessionUpdate` level. The event mapper is
a mechanical rename: `GeminiEvent` to `OpenCodeEvent`, all `gemini:*` strings to `opencode:*`.

One removal: `available_commands_update` — OpenCode doesn't use TOML slash commands.
Drop the `case 'gemini:commands'` handler entirely.

### 4.4 `copilot-adapter.ts` — Best Implementation Template

Use `copilot-adapter.ts` as the primary template (it's already stripped of TOML command
loading). Key structural elements that are identical:

- Class field declarations
- `spawn()` / `resume()` / `extractSessionId()` / `sendMessage()` methods
- `interrupt()` — identical SIGINT to SIGTERM to SIGKILL escalation
- `isAlive()` — identical
- `createTransportConnection()` — identical
- `initAndRun()` — remove Copilot-specific logic; add `--cwd` awareness
- `sendPrompt()` — identical
- `emitNdjson()` — change to `OpenCodeEvent`

**Parts requiring new logic in `opencode-adapter.ts`:**

#### `buildArgs()` — Replace Entirely

```typescript
private static buildArgs(opts: SpawnOpts, resumeSessionId: string | null): string[] {
  // 'acp' is a SUBCOMMAND, not a flag
  const args = ['acp'];

  // OpenCode requires --cwd as an explicit flag (not just process cwd)
  if (opts.cwd) {
    args.push('--cwd', opts.cwd);
  }

  // Model in provider/model format (e.g. "anthropic/claude-sonnet-4-5")
  if (opts.model) {
    args.push('-m', opts.model);
  }

  // Session resume
  if (resumeSessionId) {
    args.push('-s', resumeSessionId);
  }

  // Uncomment for debug sessions:
  // args.push('--print-logs');

  args.push(...(opts.extraArgs ?? []));
  return args;
}
```

**Note on permission modes**: There is NO `--yolo` or `--approval-mode` CLI flag. Permission
handling is done at runtime via the ACP `requestPermission` protocol or via `OPENCODE_CONFIG_CONTENT`
env var injection (see §11).

#### `spawn()` — Inject `OPENCODE_CONFIG_CONTENT`

```typescript
spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
  // Inject permission + MCP config via OPENCODE_CONFIG_CONTENT env var
  const openCodeEnv = buildOpenCodeConfig(opts);
  const mergedOpts = {
    ...opts,
    env: { ...opts.env, ...openCodeEnv },
  };
  return this.launch(prompt, mergedOpts, null);
}
```

#### `setPermissionMode()` — Map to OpenCode Agent Mode IDs

```typescript
async setPermissionMode(mode: string): Promise<boolean> {
  const conn = this.transport.getConnection();
  if (!this.sessionId || !conn) return false;
  // OpenCode ACP mode IDs are agent names from initialize() -> availableModes
  // Known: 'plan' (read-only planning), 'build', 'general', 'explore'
  // bypassPermissions/acceptEdits are handled via OPENCODE_CONFIG_CONTENT, not mode switch
  const modeMap: Record<string, string> = {
    default: 'general',
    plan: 'plan',
  };
  const opencodeMode = modeMap[mode];
  if (!opencodeMode) return false;
  await conn.setSessionMode({ sessionId: this.sessionId, modeId: opencodeMode });
  return true;
}
```

#### `setModel()` — Use Standard ACP `setSessionModel`

Unlike Copilot (which uses `unstable_setSessionModel`) and Gemini (which requires a
process restart), OpenCode implements the **standard ACP** `setSessionModel` method:

```typescript
async setModel(model: string): Promise<boolean> {
  const conn = this.transport.getConnection();
  if (!this.sessionId || !conn) return false;
  try {
    await conn.setSessionModel({ sessionId: this.sessionId, modelId: model });
    return true;
  } catch {
    return false;
  }
}
```

This is the cleanest `setModel()` of any adapter — no process restart, no `as unknown as`
casts, standard ACP spec.

---

## 5. Event Mapper Diff

### 5.1 Events that are identical to Gemini

All standard ACP `sessionUpdate` types are shared:

| ACP `sessionUpdate` type       | OpenCode source action       | Agendo mapping                                      |
| ------------------------------ | ---------------------------- | --------------------------------------------------- |
| `agent_message_chunk`          | text part delta              | `opencode:text-delta` -> `agent:text-delta`         |
| `agent_thought_chunk`          | reasoning part delta         | `opencode:thinking-delta` -> `agent:thinking-delta` |
| `tool_call` (pending)          | tool part state = pending    | `opencode:tool-start` -> `agent:tool-start`         |
| `tool_call_update` (running)   | tool part state = running    | `opencode:tool-start` (in-progress)                 |
| `tool_call_update` (completed) | tool part state = completed  | `opencode:tool-end` -> `agent:tool-end`             |
| `tool_call_update` (failed)    | tool part state = error      | `opencode:tool-end` (failed) -> `agent:tool-end`    |
| `usage_update`                 | after each assistant message | `opencode:usage` -> `agent:usage`                   |
| `plan`                         | TodoWrite tool update        | `opencode:plan` -> `agent:plan`                     |
| `current_mode_update`          | `setSessionMode()` call      | `opencode:mode-change` -> `session:mode-change`     |

### 5.2 Events that differ or are absent

| Event                       | Gemini                                                                   | OpenCode                                                                   |
| --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `available_commands_update` | Used (TOML slash commands)                                               | Not present — OpenCode uses agents, not slash commands. Drop this case.    |
| Turn complete signal        | `gemini:turn-complete` (emitted after `transport.sendPrompt()` resolves) | Same pattern — `opencode:turn-complete` emitted when `sendPrompt` resolves |

### 5.3 Complete `OpenCodeEvent` union type

```typescript
export type OpenCodeEvent =
  | { type: 'opencode:text'; text: string }
  | { type: 'opencode:text-delta'; text: string }
  | { type: 'opencode:thinking'; text: string }
  | { type: 'opencode:thinking-delta'; text: string }
  | {
      type: 'opencode:tool-start';
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId: string;
    }
  | { type: 'opencode:tool-end'; toolUseId: string; resultText?: string; failed?: boolean }
  | { type: 'opencode:turn-complete'; result: Record<string, unknown> }
  | { type: 'opencode:turn-error'; message: string }
  | { type: 'opencode:init'; model: string; sessionId: string }
  | { type: 'opencode:plan'; entries: Array<{ content: string; priority: string; status: string }> }
  | { type: 'opencode:mode-change'; modeId: string }
  | { type: 'opencode:usage'; used: number; size: number };
// Note: no opencode:commands — OpenCode doesn't use slash commands
```

---

## 6. `adapter-factory.ts` Changes

**File**: `src/lib/worker/adapters/adapter-factory.ts`

Single change — add `opencode` to the `ADAPTER_MAP`:

```typescript
import { OpenCodeAdapter } from '@/lib/worker/adapters/opencode-adapter';

const ADAPTER_MAP: Record<string, new () => AgentAdapter> = {
  claude: ClaudeSdkAdapter,
  codex: CodexAppServerAdapter,
  gemini: GeminiAdapter,
  copilot: CopilotAdapter,
  opencode: OpenCodeAdapter, // ADD
};
```

`getBinaryName(agent)` returns the basename of `agent.binaryPath`. Since opencode installs
as `/usr/bin/opencode`, `getBinaryName` returns `"opencode"`. No changes to `agent-utils.ts`.

---

## 7. Auto-Discovery — `scanner.ts` & `presets.ts`

### 7.1 `scanner.ts` — No Changes

`scanPATH()` is binary-agnostic. `opencode` is at `/usr/bin/opencode` and will appear
in scan results automatically.

**Probe result**: `which opencode` returns `/usr/bin/opencode`

### 7.2 `presets.ts` — Add `opencode` Entry

**File**: `src/lib/discovery/presets.ts`

```typescript
opencode: {
  binaryName: 'opencode',
  displayName: 'OpenCode',
  kind: 'builtin',
  toolType: 'ai-agent',
  discoveryMethod: 'preset',
  // All provider API keys that OpenCode can use
  envAllowlist: [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'XAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'AZURE_API_KEY',
    'AZURE_RESOURCE_NAME',
    'GITHUB_TOKEN',
    'MISTRAL_API_KEY',
    'DEEPSEEK_API_KEY',
    'FIREWORKS_API_KEY',
    'OPENCODE_API_KEY',
    // Internal config injection (for permission bypass)
    'OPENCODE_CONFIG_CONTENT',
  ],
  maxConcurrent: 1,
  mcpEnabled: true,
  sessionConfig: {
    sessionIdSource: 'acp',           // ACP session/new response contains sessionId
    resumeFlags: ['-s', '{{sessionRef}}'],
    continueFlags: ['-c'],
    bidirectionalProtocol: 'acp',
  },
  metadata: {
    icon: 'terminal',
    color: '#8B5CF6',
    description: 'OpenCode — open-source terminal coding agent with multi-provider support',
    homepage: 'https://opencode.ai',
  },
},
```

---

## 8. MCP Injection

### 8.1 Primary Strategy: ACP `session/new` `mcpServers`

OpenCode's `initialize()` response includes `mcpCapabilities: { http: true, sse: true }`.
This signals that MCP server injection via `session/new` is supported and functional —
confirmed directly in `packages/opencode/src/acp/agent.ts`:

> "MCP servers from NewSessionRequest.mcpServers are registered via `sdk.mcp.add()`
> at session start"

The existing `AcpTransport.loadOrCreateSession()` already passes `mcpServers` to `session/new`.
This path works for OpenCode **out of the box** — no `--additional-mcp-config` workaround
needed (unlike Copilot's bug #1040).

### 8.2 MCP Server Format Considerations

The ACP SDK `NewSessionRequest.mcpServers` uses the standard ACP format:

```typescript
type McpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>; // array-of-{name,value}
};
```

OpenCode's internal `Config.McpLocal` format (from `config/config.ts`):

```typescript
{
  type: "local",
  command: string[],              // combined [command, ...args]
  environment: Record<string, string>,  // plain dict, NOT array
}
```

OpenCode's ACP layer calls `sdk.mcp.add()` which connects to OpenCode's internal HTTP API.
**The format translation is handled internally by `@opencode-ai/sdk/v2`.** The Agendo adapter
passes the standard ACP format — no special conversion needed.

**Risk**: If `sdk.mcp.add()` doesn't handle the translation correctly, MCP injection will
fail silently. Use `OPENCODE_CONFIG_CONTENT` as a defense-in-depth fallback.

### 8.3 `OPENCODE_CONFIG_CONTENT` Fallback

The `OPENCODE_CONFIG_CONTENT` env var injects raw JSON config before any ACP handshake.
This is the preferred path for both permission bypass AND MCP pre-configuration:

```typescript
// Helper in opencode-adapter.ts
function buildOpenCodeConfig(opts: SpawnOpts): Record<string, string> {
  const config: Record<string, unknown> = {};

  // Permission bypass via config
  if (opts.permissionMode === 'bypassPermissions' || opts.permissionMode === 'dontAsk') {
    config.permission = {
      bash: 'allow',
      edit: 'allow',
      write: 'allow',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      task: 'allow',
      todowrite: 'allow',
      todoread: 'allow',
    };
  } else if (opts.permissionMode === 'acceptEdits') {
    config.permission = {
      bash: 'ask',
      edit: 'allow',
      write: 'allow',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
    };
  }

  // Pre-configure MCP servers as fallback
  if (opts.mcpServers?.length) {
    config.mcp = {};
    for (const srv of opts.mcpServers) {
      (config.mcp as Record<string, unknown>)[srv.name] = {
        type: 'local',
        command: [srv.command, ...srv.args],
        environment: Object.fromEntries(srv.env.map(({ name, value }) => [name, value])),
      };
    }
  }

  if (Object.keys(config).length === 0) return {};
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
```

---

## 9. Model Discovery

### 9.1 `opencode models [provider]` Command

OpenCode has a built-in model listing command. With API keys configured, it returns
all available models per provider. Output format (one per line): `provider/modelId`.

```bash
ANTHROPIC_API_KEY=xxx opencode models anthropic
# -> anthropic/claude-opus-4-5
# -> anthropic/claude-sonnet-4-5
# -> anthropic/claude-haiku-4-5
# -> ...
```

Without keys (as tested on this machine):

```bash
opencode models
# -> opencode/gpt-5-nano
# -> opencode/mimo-v2-flash-free
# -> opencode/minimax-m2.5-free
# -> opencode/nemotron-3-super-free
```

(Only free/public models appear without auth.)

### 9.2 Provider-to-env-var Mapping

| Provider ID      | Auth env vars                                                                       |
| ---------------- | ----------------------------------------------------------------------------------- |
| `anthropic`      | `ANTHROPIC_API_KEY`                                                                 |
| `openai`         | `OPENAI_API_KEY`                                                                    |
| `google`         | `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`                                    |
| `google-vertex`  | `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` |
| `github-copilot` | `GITHUB_TOKEN`                                                                      |
| `amazon-bedrock` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`                          |
| `azure`          | `AZURE_RESOURCE_NAME`, `AZURE_API_KEY`                                              |
| `openrouter`     | `OPENROUTER_API_KEY`                                                                |
| `mistral`        | `MISTRAL_API_KEY`                                                                   |
| `groq`           | `GROQ_API_KEY`                                                                      |
| `xai`            | `XAI_API_KEY`                                                                       |
| `deepseek`       | `DEEPSEEK_API_KEY`                                                                  |
| `fireworks-ai`   | `FIREWORKS_API_KEY`                                                                 |
| `opencode`       | `OPENCODE_API_KEY` (opencode's own hosted API)                                      |

### 9.3 Model Format Convention

All OpenCode models use `provider/model` format. This is a fundamental difference from
other adapters (Claude, Codex, Gemini, Copilot all use bare model names).

Agendo's `capability.config.defaultModel` for OpenCode must store the full format:
`"anthropic/claude-sonnet-4-5"`, NOT `"claude-sonnet-4-5"`.

The `SpawnOpts.model` field passed to `buildArgs()` is forwarded as `-m anthropic/claude-sonnet-4-5`.

### 9.4 Comparison with Other Agents

| Agent        | Model discovery                            | Dynamic?            | Format           |
| ------------ | ------------------------------------------ | ------------------- | ---------------- |
| Claude       | `strings` grep (labels only)               | No                  | bare name        |
| Codex        | `codex app-server` `model/list` RPC        | Yes                 | bare name        |
| Gemini       | `require()` from `@google/gemini-cli-core` | Quasi-static        | bare name        |
| Copilot      | `--help` choices list                      | No (version-pinned) | bare name        |
| **OpenCode** | `opencode models [provider]`               | Yes (live)          | `provider/model` |

---

## 10. Auth & Multi-Provider Config

### 10.1 Auth Mechanism

OpenCode reads provider API keys directly from environment variables (see §9.2). There is
no single "OpenCode auth token" — each provider has its own env var.

For headless server use, set the relevant API key in the worker's `ecosystem.config.js`:

```javascript
env: {
  ANTHROPIC_API_KEY: 'sk-ant-...',
  // and/or
  OPENAI_API_KEY: 'sk-...',
}
```

The `opencode auth login` command stores credentials in
`~/.local/share/opencode/opencode.db` (SQLite). For server deployments, env vars are preferred.

### 10.2 Auth Failure Behavior

If no API key is configured for the requested model's provider, OpenCode likely emits an
error through the ACP event stream. Exact error format requires live testing to confirm —
likely a `session:error` event or a failed `session/new` response.

**Recommendation**: Pre-check that at least one provider's API key is set before spawning.
The adapter should emit a `system:error` event early rather than hanging on an
unanswered permission prompt.

### 10.3 Multi-Provider Capability Design

Because OpenCode supports many providers, Agendo should expose the model list with the
full `provider/model` identifier. Users can choose `anthropic/claude-sonnet-4-5`,
`openai/gpt-4o`, or `openrouter/meta/llama-3.1-405b` from the same OpenCode agent row.

---

## 11. Permission / Approval Model

### 11.1 ACP Permission Flow

OpenCode uses the standard ACP `requestPermission` protocol. From `acp/agent.ts`:

```typescript
this.permissionOptions = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
];
```

The ACP response requires `{ outcome: { outcome: "selected", optionId } }` — same nested
structure as Gemini/Copilot.

### 11.2 Permission Modes Mapping

| Agendo `permissionMode` | Implementation strategy                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `bypassPermissions`     | `OPENCODE_CONFIG_CONTENT` with all tools = `"allow"` — prevents `requestPermission` from firing |
| `dontAsk`               | Same as `bypassPermissions`                                                                     |
| `acceptEdits`           | `OPENCODE_CONFIG_CONTENT` with file tools = `"allow"`, bash = `"ask"`                           |
| `default`               | No config override; ACP handler prompts user for each tool                                      |
| `plan`                  | `setSessionMode({ modeId: "plan" })` after init — uses OpenCode's built-in plan agent           |

**Note**: For `bypassPermissions`, the `OPENCODE_CONFIG_CONTENT` env var injects permission
rules before the ACP handshake. This is the only reliable method since OpenCode has no
`--yolo` CLI flag.

### 11.3 Config-Based Permission Bypass

```json
{
  "permission": {
    "bash": "allow",
    "edit": "allow",
    "write": "allow",
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "webfetch": "allow",
    "websearch": "allow",
    "task": "allow",
    "todowrite": "allow",
    "todoread": "allow"
  }
}
```

Injected via `OPENCODE_CONFIG_CONTENT` env var. OpenCode's config loading order gives this
env var higher precedence than project-level configs.

### 11.4 Plan Mode

OpenCode has a native `plan` agent that restricts modifications. When Agendo spawns a
session in `plan` mode:

1. Spawn normally (no special CLI flag)
2. After `initialize()`, call `conn.setSessionMode({ sessionId, modeId: 'plan' })`
3. The plan agent uses the `mcp__agendo__save_plan` tool as the plan capture mechanism

This is cleaner than Gemini's plan mode (which requires `--approval-mode plan` at launch).

---

## 12. Session Resume

### 12.1 Session Identity

OpenCode sessions are stored in SQLite at `~/.local/share/opencode/opencode.db`.
Session IDs are UUIDs (confirmed from `Session.Info.id` type in source).

### 12.2 Resume Mechanism

Via ACP protocol (used by Agendo's `AcpTransport.loadOrCreateSession()`):

- `session/resume` (unstable) — fast path, no history replay
- `session/load` — full history replay fallback
- `session/new` — new session fallback

Via CLI (for reference):

- `-s <sessionId>` — resume specific session
- `-c / --continue` — resume last session
- `--fork` — fork a session before continuing

Agendo uses the ACP protocol path — **no adapter changes needed for resume**.

### 12.3 Session Export/Import

OpenCode has `opencode export <sessionID>` and `opencode import <file>` commands for
session portability. This is not needed for Agendo's integration but is useful for debugging.

---

## 13. DB Seed

### 13.1 Automatic Seeding via Discovery

With `opencode` added to `AI_TOOL_PRESETS`, running `pnpm db:seed` with opencode installed
will automatically register the agent and its capability.

### 13.2 Agent Row

```sql
INSERT INTO agents (
  id, name, slug, binary_path, kind, tool_type,
  mcp_enabled, max_concurrent, env_allowlist, metadata, session_config
) VALUES (
  gen_random_uuid(),
  'OpenCode',
  'opencode-1',
  '/usr/bin/opencode',
  'builtin',
  'ai-agent',
  true,
  1,
  '["ANTHROPIC_API_KEY","OPENAI_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","GEMINI_API_KEY",
    "OPENROUTER_API_KEY","GROQ_API_KEY","XAI_API_KEY","MISTRAL_API_KEY","DEEPSEEK_API_KEY",
    "AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_REGION","AZURE_API_KEY",
    "AZURE_RESOURCE_NAME","GITHUB_TOKEN","OPENCODE_API_KEY","OPENCODE_CONFIG_CONTENT"]',
  '{
    "icon": "terminal",
    "color": "#8B5CF6",
    "description": "OpenCode open-source terminal coding agent with multi-provider support",
    "homepage": "https://opencode.ai"
  }',
  '{
    "sessionIdSource": "acp",
    "resumeFlags": ["-s", "{{sessionRef}}"],
    "continueFlags": ["-c"],
    "bidirectionalProtocol": "acp"
  }'
) ON CONFLICT (slug) DO NOTHING;
```

### 13.3 Capability Row (Prompt-Mode)

```sql
-- First get the agent ID for slug='opencode-1', then:
INSERT INTO capabilities (
  id, agent_id, name, slug, kind, description, config
) VALUES (
  gen_random_uuid(),
  '<agent-id>',
  'OpenCode Chat',
  'opencode-chat-1',
  'prompt',
  'Interactive coding agent session with OpenCode (multi-provider)',
  '{
    "defaultModel": "anthropic/claude-sonnet-4-5",
    "availableModels": [
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "openai/o3-mini",
      "openai/o3",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "google/gemini-2.0-flash",
      "openrouter/anthropic/claude-sonnet-4-5",
      "groq/llama-3.3-70b-versatile"
    ]
  }'
) ON CONFLICT (slug) DO NOTHING;
```

**Model list note**: Run `opencode models` with each provider's API key to get the full
current list. The above is representative; re-run `pnpm db:seed` after configuring API keys.

### 13.4 Agent Slug Convention

Following the existing pattern: `claude-code-1`, `codex-cli-1`, `gemini-cli-1`,
`copilot-cli-1` -> `opencode-1`.

---

## 14. File-by-File Change List

### New Files (Create)

| File                                                 | Lines (est.) | Notes                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/worker/adapters/opencode-adapter.ts`        | ~250         | Main adapter. Copy of `copilot-adapter.ts`. Replace `buildArgs()`, add `buildOpenCodeConfig()` helper, fix `setPermissionMode()` mode IDs, use standard `setSessionModel()`. Inject `OPENCODE_CONFIG_CONTENT` in `spawn()`. |
| `src/lib/worker/adapters/opencode-event-mapper.ts`   | ~100         | Copy of `gemini-event-mapper.ts`. Rename `GeminiEvent` to `OpenCodeEvent`, all `gemini:*` to `opencode:*`. Remove `opencode:commands` case.                                                                                 |
| `src/lib/worker/adapters/opencode-client-handler.ts` | ~80          | Copy of `gemini-client-handler.ts`. Change `GeminiEvent` import to `OpenCodeEvent`. Body is logically identical (kind-based lookup is compatible with opencode's optionIds).                                                |

### Modified Files

| File                                         | Change                                                                 | Complexity         |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------ |
| `src/lib/worker/adapters/adapter-factory.ts` | Add `opencode: OpenCodeAdapter` to `ADAPTER_MAP`                       | Trivial (2 lines)  |
| `src/lib/discovery/presets.ts`               | Add `opencode` entry to `AI_TOOL_PRESETS`                              | Simple (~35 lines) |
| `src/lib/worker/session-preambles.ts`        | Add `opencode` branch (same as `gemini`/`copilot` in binaryName check) | Simple (~5 lines)  |

### No Changes Needed

- `src/lib/worker/adapters/gemini-acp-transport.ts` — reused as-is
- `src/lib/worker/adapters/base-adapter.ts` — abstract base, unchanged
- `src/lib/worker/session-runner.ts` — adapter-agnostic
- `src/lib/worker/session-process.ts` — adapter-agnostic
- `src/lib/worker/adapters/types.ts` — no new types needed
- `src/lib/discovery/scanner.ts` — binary-agnostic
- DB migrations — no schema changes needed

### Test Files (Recommended)

| File                                                              | Notes                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/lib/worker/adapters/__tests__/opencode-adapter.test.ts`      | Mirror of `copilot-adapter.test.ts` / `gemini-adapter.test.ts` |
| `src/lib/worker/adapters/__tests__/opencode-event-mapper.test.ts` | Mirror of `gemini-event-mapper.test.ts`                        |

---

## 15. Key Risks

### Risk 1: `OPENCODE_CONFIG_CONTENT` permission bypass not honored (MEDIUM impact, LOW probability)

- **Issue**: OpenCode's config loading order may not give `OPENCODE_CONFIG_CONTENT` highest
  priority, or the config parsing may not cover all tool types.
- **Mitigation**: Test with `bypassPermissions` and verify no `requestPermission` calls arrive.
- **Fallback**: The existing ACP `requestPermission` handler auto-allows when no `approvalHandler`
  is set — silent bypass works even without the config injection.

### Risk 2: MCP format translation in `sdk.mcp.add()` (MEDIUM impact, MEDIUM probability)

- **Issue**: The ACP `session/new` `mcpServers` payload uses standard ACP format
  (`{command, args, env: [{name,value}]}`), but OpenCode's internal config expects
  `{type:"local", command: string[], environment: Record<string,string>}`. The translation
  happens inside `@opencode-ai/sdk/v2` — if it's not implemented, MCP servers won't start.
- **Mitigation**: Use `OPENCODE_CONFIG_CONTENT` to pre-configure MCP servers as defense-in-depth.
- **Verification**: After session init, check whether Agendo MCP tool names appear in events.

### Risk 3: `setSessionMode()` mode IDs unknown (LOW impact, HIGH probability)

- **Issue**: The `availableModes` in `initialize()` response are not confirmed without
  a live session. Mode IDs are OpenCode's internal agent names, but the exact set needs verification.
- **Mitigation**: Log `initResult.agentCapabilities.modes` on first connect. Use soft fallback
  (`return false` for unknown modes).
- **Impact**: Low — initial permission mode is set via `OPENCODE_CONFIG_CONTENT` at spawn time.

### Risk 4: `provider/model` format mismatch in Agendo DB (HIGH impact, MEDIUM probability)

- **Issue**: If Agendo's session runner strips the provider prefix
  (e.g., `opts.model = "claude-sonnet-4-5"` instead of `"anthropic/claude-sonnet-4-5"`),
  OpenCode will fail to find the model.
- **Mitigation**: Clearly document in `opencode-adapter.ts` that `-m` expects `provider/model`
  format. Store full format in capability `config.defaultModel`. Add a format warning in `buildArgs()`:
  ```typescript
  if (opts.model && !opts.model.includes('/')) {
    log.warn({ model: opts.model }, 'OpenCode model should be in provider/model format');
  }
  ```

### Risk 5: OpenCode startup bootstrapping time (LOW impact, LOW probability)

- **Issue**: From the observed startup log, `opencode acp` performs SQLite DB migrations on
  first run and bootstraps multiple subsystems (LSP, file watcher, scheduler). Cold start
  observed at ~30ms in testing with the migration already done.
- **Mitigation**: ACP `initialize()` in `AcpTransport` has a 30s timeout. No change needed.

### Risk 6: Bun-compiled binary (no source debugging) (LOW impact, LOW probability)

- **Issue**: The opencode binary is Bun-compiled. Stack traces and Node.js debugging won't apply.
- **Mitigation**: Use `--print-logs` flag during development to get OpenCode's structured logs
  on stderr. Forward stderr to Agendo's `dataCallbacks` as `system:info` events.

---

## Appendix A: ACP Launch Sequence

```
Agendo spawns: opencode acp --cwd /project/path -m anthropic/claude-sonnet-4-5
  (env: OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"allow",...}}' for bypassPermissions)

OpenCode starts:
  1. Bootstraps SQLite DB, config, plugins (~30ms)
  2. Starts internal HTTP server on random port
  3. Creates ACP AgentSideConnection over stdio (ndJsonStream)
  4. Listens for ACP initialize request

Agendo (AcpTransport.initialize()):
  -> ACP initialize { protocolVersion: 1, clientInfo: { name: "agendo" } }
  <- ACP initialize response {
       agentCapabilities: {
         loadSession: true,
         mcpCapabilities: { http: true, sse: true },
         sessionCapabilities: { fork: true, list: true, resume: true },
       }
     }

Agendo (AcpTransport.loadOrCreateSession()):
  -> ACP session/new { cwd: "/project/path", mcpServers: [...] }
  <- ACP session/new response { sessionId: "uuid-..." }
  -> sessionRefCallback("uuid-...")

Agendo (AcpTransport.sendPrompt()):
  -> ACP session/prompt { sessionId, prompt: [{ type: "text", text: "..." }] }
  <- ACP sessionUpdate { sessionUpdate: "agent_message_chunk", ... }  (streaming)
  <- ACP sessionUpdate { sessionUpdate: "tool_call", ... }
  <- ACP requestPermission { toolCall, options: [...] }  (if not in bypass mode)
  -> ACP requestPermission response { outcome: { outcome: "selected", optionId: "once" } }
  <- ACP sessionUpdate { sessionUpdate: "tool_call_update", status: "completed", ... }
  <- ACP session/prompt response { usage: {...} }
  -> emitNdjson({ type: 'opencode:turn-complete', result: { usage: {...} } })

Agendo waits for next sendMessage()...
```

---

## Appendix B: `opencode run --format json` as Alternative

For fire-and-forget executions (Agendo `kind='execution'`), `opencode run` with
`--format json` offers a simpler integration path:

```bash
opencode run "fix the bug in foo.ts" \
  --format json \
  -m anthropic/claude-sonnet-4-5 \
  -s previous-session-uuid
```

Output (NDJSON on stdout):

```json
{"type":"step_start","timestamp":1234,"sessionID":"...","part":{...}}
{"type":"text","timestamp":1234,"sessionID":"...","part":{"content":"Here is the fix..."}}
{"type":"tool_use","timestamp":1234,"sessionID":"...","part":{...}}
{"type":"step_finish","timestamp":1234,"sessionID":"...","part":{...}}
```

This is structurally similar to Gemini's headless stream-json mode. It could be used for
template-mode capabilities while `opencode acp` handles prompt-mode sessions. However, for
the initial implementation, focus on the ACP path — it handles both use cases.

---

## Appendix C: `opencode serve` HTTP API (Alternative Integration)

If the ACP stdio integration proves unstable, `opencode serve` exposes a REST+SSE API:

```
opencode serve --port 4200
# -> prints: opencode server listening on http://127.0.0.1:4200
```

Key endpoints (from server.ts Hono app):

- `GET /global/event` — SSE stream of all events
- `POST /session/create` — create a new session
- `POST /session/:id/message` — send a message
- `GET /provider` — list providers and models
- `GET /mcp` — MCP server status

The server supports `OPENCODE_SERVER_PASSWORD` for Basic Auth. This REST path is more
"stable" across binary versions but requires managing an HTTP server lifecycle.
Recommended as a future fallback if ACP has persistent issues.
