# Claude Code Headless Mode & Stream-JSON Bidirectional Protocol

## Deep Dive Research Document

**Date**: 2026-02-17
**Status**: Comprehensive research complete
**Purpose**: Understand how to programmatically control Claude Code from a Node.js app with full bidirectional communication

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Headless Mode (`--print`)](#2-headless-mode---print)
3. [Stream-JSON Protocol](#3-stream-json-protocol)
4. [The Exact Protocol Specification](#4-the-exact-protocol-specification)
5. [Session Management in Headless Mode](#5-session-management-in-headless-mode)
6. [MCP Integration in Headless Mode](#6-mcp-integration-in-headless-mode)
7. [Permission Handling & Tool Approval](#7-permission-handling--tool-approval)
8. [The Agent SDK (Recommended Approach)](#8-the-agent-sdk-recommended-approach)
9. [Real-World Usage Examples](#9-real-world-usage-examples)
10. [Comparison: CLI vs Agent SDK vs Direct API](#10-comparison-cli-vs-agent-sdk-vs-direct-api)
11. [Security Considerations](#11-security-considerations)
12. [Reference Tables](#12-reference-tables)
13. [Sources](#13-sources)

---

## 1. Executive Summary

There are now **three ways** to programmatically control Claude Code:

| Approach                   | Package/Command                  | Best For                              |
| :------------------------- | :------------------------------- | :------------------------------------ |
| **CLI (`claude -p`)**      | `claude` binary                  | Scripts, CI/CD, shell automation      |
| **Agent SDK (TypeScript)** | `@anthropic-ai/claude-agent-sdk` | Production Node.js apps (RECOMMENDED) |
| **Agent SDK (Python)**     | `claude-agent-sdk`               | Production Python apps                |

**Critical finding**: The CLI's `--input-format stream-json` provides basic stdin-based bidirectional communication, but the **Agent SDK** is the officially recommended approach for programmatic control. It provides native TypeScript/Python objects, callback-based tool approval (`canUseTool`), streaming events, and proper session management -- all without having to parse NDJSON from stdout.

The CLI headless mode and the Agent SDK share the same underlying engine. The Agent SDK is essentially a wrapper around the Claude Code binary that provides a clean programmatic interface.

---

## 2. Headless Mode (`--print`)

### 2.1 Basic Usage

The `-p` (or `--print`) flag runs Claude Code non-interactively. All CLI options work with it:

```bash
# Simple one-shot query
claude -p "What does the auth module do?"

# With piped input
cat logs.txt | claude -p "Explain these errors"

# With tool restrictions
claude -p "Fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
```

### 2.2 What Changes in Headless vs Interactive Mode

| Behavior            | Interactive Mode                 | Headless (`-p`) Mode                                                          |
| :------------------ | :------------------------------- | :---------------------------------------------------------------------------- |
| UI rendering        | Full TUI with panels             | No UI, stdout only                                                            |
| Tool approval       | Interactive prompts              | Must use `--allowedTools`, `--permission-mode`, or `--permission-prompt-tool` |
| Slash commands      | Available (`/commit`, `/review`) | NOT available; describe the task instead                                      |
| Skills              | Available                        | NOT available directly                                                        |
| Input               | Terminal keyboard                | stdin (text or stream-json)                                                   |
| Output              | Terminal rendering               | text, json, or stream-json                                                    |
| Session persistence | Automatic                        | Automatic (disable with `--no-session-persistence`)                           |
| Multi-turn          | Built-in REPL                    | Via `--continue`, `--resume`, or `--input-format stream-json`                 |

### 2.3 Complete CLI Flags Reference

#### Core Flags

| Flag                         | Description                                           | Example                       |
| :--------------------------- | :---------------------------------------------------- | :---------------------------- |
| `--print`, `-p`              | Run non-interactively                                 | `claude -p "query"`           |
| `--output-format`            | Output format: `text`, `json`, `stream-json`          | `--output-format stream-json` |
| `--input-format`             | Input format: `text`, `stream-json`                   | `--input-format stream-json`  |
| `--verbose`                  | Show full turn-by-turn output                         | `--verbose`                   |
| `--include-partial-messages` | Include streaming token events (requires stream-json) | `--include-partial-messages`  |
| `--replay-user-messages`     | Re-emit user messages from stdin on stdout            | `--replay-user-messages`      |

#### Permission Flags

| Flag                             | Description                               | Example                                         |
| :------------------------------- | :---------------------------------------- | :---------------------------------------------- |
| `--permission-mode`              | Set permission mode                       | `--permission-mode acceptEdits`                 |
| `--allowedTools`                 | Tools that auto-execute without prompting | `"Bash(git log *)" "Read"`                      |
| `--disallowedTools`              | Tools removed from model context entirely | `"Bash(rm *)" "Write"`                          |
| `--tools`                        | Restrict which tools are available        | `"Bash,Edit,Read"`                              |
| `--dangerously-skip-permissions` | Skip ALL permission prompts (dangerous)   | `--dangerously-skip-permissions`                |
| `--permission-prompt-tool`       | MCP tool to handle permission prompts     | `--permission-prompt-tool mcp__approver__check` |

#### Budget and Limit Flags

| Flag               | Description                                         | Example                 |
| :----------------- | :-------------------------------------------------- | :---------------------- |
| `--max-budget-usd` | Maximum dollar spend before stopping                | `--max-budget-usd 5.00` |
| `--max-turns`      | Limit agentic turns (exits with error when reached) | `--max-turns 10`        |

#### Session Flags

| Flag                       | Description                           | Example                       |
| :------------------------- | :------------------------------------ | :---------------------------- |
| `--continue`, `-c`         | Continue most recent conversation     | `claude -c -p "Follow up"`    |
| `--resume`, `-r`           | Resume specific session by ID or name | `--resume "auth-refactor"`    |
| `--session-id`             | Use a specific UUID for the session   | `--session-id "550e8400-..."` |
| `--fork-session`           | Create new session ID when resuming   | `--resume abc --fork-session` |
| `--no-session-persistence` | Don't save session to disk            | `--no-session-persistence`    |

#### System Prompt Flags

| Flag                          | Description                  | Modes               |
| :---------------------------- | :--------------------------- | :------------------ |
| `--system-prompt`             | Replace entire system prompt | Interactive + Print |
| `--system-prompt-file`        | Replace with file contents   | Print only          |
| `--append-system-prompt`      | Append to default prompt     | Interactive + Print |
| `--append-system-prompt-file` | Append file contents         | Print only          |

#### Model and MCP Flags

| Flag                  | Description                      | Example                   |
| :-------------------- | :------------------------------- | :------------------------ |
| `--model`             | Set model (alias or full name)   | `--model sonnet`          |
| `--fallback-model`    | Fallback when primary overloaded | `--fallback-model sonnet` |
| `--mcp-config`        | Load MCP servers from JSON       | `--mcp-config ./mcp.json` |
| `--strict-mcp-config` | Only use MCP from --mcp-config   | `--strict-mcp-config`     |

#### Other Flags

| Flag            | Description                                 |
| :-------------- | :------------------------------------------ |
| `--json-schema` | Get validated JSON output matching a schema |
| `--add-dir`     | Add additional working directories          |
| `--agents`      | Define custom subagents via JSON            |
| `--debug`       | Enable debug mode with category filtering   |

### 2.4 Permission Modes

| Mode                | Description            | Tool Behavior                                                        |
| :------------------ | :--------------------- | :------------------------------------------------------------------- |
| `default`           | Standard behavior      | Unmatched tools trigger `canUseTool` callback (SDK) or block (CLI)   |
| `acceptEdits`       | Auto-accept file edits | File edits, `mkdir`, `rm`, `mv`, `cp` auto-approved                  |
| `bypassPermissions` | Skip all checks        | All tools run without prompts (dangerous -- propagates to subagents) |
| `plan`              | Planning only          | No tool execution; Claude plans without making changes               |

---

## 3. Stream-JSON Protocol

### 3.1 Overview

The stream-json protocol uses **newline-delimited JSON (NDJSON)** for communication. Each line of output is a self-contained JSON object. When combined with `--input-format stream-json`, it enables bidirectional communication over stdin/stdout.

### 3.2 Output Format (`--output-format stream-json`)

Every event is a JSON object on its own line. The primary message types are:

```
┌──────────────────────────────────────────────────────────┐
│                   OUTPUT MESSAGE TYPES                    │
├──────────────┬───────────────────────────────────────────┤
│ type         │ Description                               │
├──────────────┼───────────────────────────────────────────┤
│ system       │ Session init (subtype: "init")            │
│ assistant    │ Claude's response (text + tool_use)       │
│ user         │ User messages (when --replay-user-msgs)   │
│ stream_event │ Partial tokens (when --include-partial)   │
│ result       │ Final result with cost/usage data         │
└──────────────┴───────────────────────────────────────────┘
```

### 3.3 Input Format (`--input-format stream-json`)

Messages sent via stdin use this JSONL format:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "Your message here"
  },
  "session_id": "default",
  "parent_tool_use_id": null
}
```

**Field definitions**:

- `type`: Always `"user"` for user input messages
- `message.role`: Always `"user"`
- `message.content`: String or array of content blocks (text, images)
- `session_id`: Use `"default"` for new sessions, or the captured session ID
- `parent_tool_use_id`: Typically `null` for top-level messages

### 3.4 Complete Protocol Flow

```
┌─────────────┐                          ┌─────────────┐
│  Your App   │                          │ Claude Code  │
│  (Node.js)  │                          │   Process    │
└──────┬──────┘                          └──────┬──────┘
       │                                        │
       │  spawn: claude -p --output-format      │
       │         stream-json --input-format     │
       │         stream-json --verbose          │
       │         --include-partial-messages     │
       │────────────────────────────────────────>│
       │                                        │
       │         Initial prompt via args        │
       │         OR first stdin message         │
       │                                        │
       │<───────────────────────────────────────│
       │  {"type":"system","subtype":"init",    │
       │   "session_id":"abc123",               │
       │   "tools":["Read","Edit","Bash",...],  │
       │   "model":"claude-opus-4-6",           │
       │   "mcp_servers":[...],                 │
       │   "permissionMode":"default"}          │
       │                                        │
       │<───────────────────────────────────────│
       │  {"type":"stream_event",               │
       │   "event":{"type":"message_start",...}} │
       │                                        │
       │<───────────────────────────────────────│
       │  {"type":"stream_event",               │
       │   "event":{"type":"content_block_delta",│
       │     "delta":{"type":"text_delta",      │
       │       "text":"Let me "}}}              │
       │                                        │
       │  ... more text_delta events ...        │
       │                                        │
       │<───────────────────────────────────────│
       │  {"type":"stream_event",               │
       │   "event":{"type":"content_block_start",│
       │     "content_block":{"type":"tool_use",│
       │       "name":"Read"}}}                 │
       │                                        │
       │  ... tool input deltas ...             │
       │                                        │
       │<───────────────────────────────────────│
       │  {"type":"stream_event",               │
       │   "event":{"type":"content_block_stop"}}│
       │                                        │
       │<───────────────────────────────────────│
       │  {"type":"assistant",                  │
       │   "uuid":"...",                        │
       │   "session_id":"abc123",               │
       │   "message":{"content":[               │
       │     {"type":"text","text":"..."},       │
       │     {"type":"tool_use","name":"Read",  │
       │       "input":{"file_path":"..."}}     │
       │   ]}}                                  │
       │                                        │
       │  ... tool executes internally ...      │
       │                                        │
       │  ... more assistant messages ...       │
       │                                        │
       │<───────────────────────────────────────│
       │  {"type":"result",                     │
       │   "subtype":"success",                 │
       │   "result":"Here's what I found...",   │
       │   "session_id":"abc123",               │
       │   "duration_ms":12345,                 │
       │   "total_cost_usd":0.05,              │
       │   "num_turns":3,                       │
       │   "usage":{...}}                       │
       │                                        │
       │  ──── TURN COMPLETE ────               │
       │                                        │
       │  Send follow-up via stdin:             │
       │────────────────────────────────────────>│
       │  {"type":"user","message":             │
       │   {"role":"user",                      │
       │    "content":"Now fix the bug"},       │
       │   "session_id":"abc123",               │
       │   "parent_tool_use_id":null}           │
       │                                        │
       │<───────────────────────────────────────│
       │  ... more stream events ...            │
       │  ... assistant messages ...            │
       │  ... result message ...                │
       │                                        │
```

### 3.5 Stream Event Types (with `--include-partial-messages`)

When `--include-partial-messages` is enabled, you receive raw Claude API streaming events:

| Event Type            | Description                     | Contains                           |
| :-------------------- | :------------------------------ | :--------------------------------- |
| `message_start`       | Start of a new message          | Message metadata                   |
| `content_block_start` | Start of text or tool_use block | Block type, tool name              |
| `content_block_delta` | Incremental content update      | `text_delta` or `input_json_delta` |
| `content_block_stop`  | End of a content block          | --                                 |
| `message_delta`       | Message-level update            | Stop reason, usage                 |
| `message_stop`        | End of the message              | --                                 |

### 3.6 Message Flow Sequence

```
Without --include-partial-messages:
  SystemMessage (init)
  AssistantMessage (complete response)
  ... tool executes ...
  AssistantMessage (next turn)
  ... more turns ...
  ResultMessage (final)

With --include-partial-messages:
  SystemMessage (init)
  StreamEvent (message_start)
  StreamEvent (content_block_start) - text
  StreamEvent (content_block_delta) - text chunks...
  StreamEvent (content_block_stop)
  StreamEvent (content_block_start) - tool_use
  StreamEvent (content_block_delta) - tool input chunks...
  StreamEvent (content_block_stop)
  StreamEvent (message_delta)
  StreamEvent (message_stop)
  AssistantMessage (complete, all content)
  ... tool executes internally ...
  ... more streaming events for next turn ...
  ResultMessage (final)
```

### 3.7 Key Flags for Stream-JSON

| Flag                          | Purpose                                 |
| :---------------------------- | :-------------------------------------- |
| `--output-format stream-json` | Enable NDJSON output                    |
| `--input-format stream-json`  | Enable JSONL input via stdin            |
| `--verbose`                   | Include tool results and full turn data |
| `--include-partial-messages`  | Include per-token streaming events      |
| `--replay-user-messages`      | Echo stdin user messages back on stdout |

### 3.8 Answering Critical Questions

**Can we send a NEW user message while Claude is still processing?**
With the CLI: Not directly mid-stream. The protocol is turn-based -- you send a message, wait for the result, then send the next. However, with the Agent SDK's streaming input mode (AsyncIterable), you can queue messages and the SDK handles sequencing. The SDK also supports `interrupt()` to cancel the current turn.

**Can we approve/reject tool calls via the CLI?**
Not via stdin stream-json messages. Tool approval in headless CLI mode is handled by:

1. Pre-configured `--allowedTools` / `--disallowedTools`
2. `--permission-mode` (acceptEdits, bypassPermissions, etc.)
3. `--permission-prompt-tool` (delegates to an MCP tool)

With the Agent SDK, you use the `canUseTool` callback for interactive approval.

**Can we cancel mid-stream?**
CLI: Kill the process (SIGTERM/SIGINT). Agent SDK: Use `query.interrupt()` in streaming mode, or the `AbortController` in the options.

**What's `--replay-user-messages` for?**
It re-emits user messages from stdin back on stdout. This enables downstream consumers to see both sides of the conversation in the output stream. Only works with `--input-format stream-json` and `--output-format stream-json`.

**What's `--include-partial-messages` for?**
Without it, you only get complete `AssistantMessage` objects after Claude finishes each response. With it, you receive `StreamEvent` messages containing raw API events as they arrive (text_delta, input_json_delta, etc.), enabling real-time token streaming in your UI.

---

## 4. The Exact Protocol Specification

### 4.1 System Init Message

The first message emitted by Claude Code in stream-json mode:

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: string; // UUID for this message
  session_id: string; // Session identifier (CAPTURE THIS)
  apiKeySource: string;
  cwd: string; // Working directory
  tools: string[]; // Available tools: ["Read", "Edit", "Bash", ...]
  mcp_servers: {
    // Connected MCP servers
    name: string;
    status: string; // "connected" | "failed" | "needs-auth" | "pending"
  }[];
  model: string; // e.g. "claude-opus-4-6"
  permissionMode: string;
  slash_commands: string[];
  output_style: string;
};
```

### 4.2 Assistant Message

Complete assistant response after all content is generated:

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
    >;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  parent_tool_use_id: string | null; // Non-null if from a subagent
};
```

### 4.3 User Message (Input via stdin)

```typescript
type SDKUserMessage = {
  type: 'user';
  message: {
    role: 'user';
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
        >;
  };
  session_id: string; // Use "default" initially, then captured ID
  parent_tool_use_id: string | null; // Usually null
};
```

### 4.4 Stream Event (Partial Messages)

```typescript
type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: RawMessageStreamEvent; // Raw Claude API event
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
};
```

The `event` field contains standard Anthropic API stream events:

- `{ type: "message_start", message: {...} }`
- `{ type: "content_block_start", content_block: { type: "text" | "tool_use", ... } }`
- `{ type: "content_block_delta", delta: { type: "text_delta", text: "..." } }`
- `{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "..." } }`
- `{ type: "content_block_stop" }`
- `{ type: "message_delta", delta: { stop_reason: "end_turn" | "tool_use" }, usage: {...} }`
- `{ type: "message_stop" }`

### 4.5 Result Message

```typescript
type SDKResultMessage =
  | {
      type: 'result';
      subtype: 'success';
      uuid: string;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string; // Final text result
      total_cost_usd: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      };
      modelUsage: {
        [modelName: string]: {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          webSearchRequests: number;
          costUSD: number;
          contextWindow: number;
        };
      };
      permission_denials: Array<{
        tool_name: string;
        tool_use_id: string;
        tool_input: any;
      }>;
      structured_output?: unknown; // When using --json-schema
    }
  | {
      type: 'result';
      subtype:
        | 'error_max_turns'
        | 'error_during_execution'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries';
      // ... same fields but with errors: string[] instead of result
    };
```

### 4.6 Compact Boundary Message

Emitted when conversation history is compacted (context window management):

```typescript
type SDKCompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  uuid: string;
  session_id: string;
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
  };
};
```

---

## 5. Session Management in Headless Mode

### 5.1 Creating and Resuming Sessions

```bash
# First request -- capture session_id from output
session_id=$(claude -p "Review this codebase" --output-format json | jq -r '.session_id')

# Continue with --resume
claude -p "Now fix the issues" --resume "$session_id"

# Or use --continue for most recent session
claude -p "Follow up" --continue
```

### 5.2 Session Storage

Sessions are stored as JSONL files at:

```
~/.claude/projects/<project-hash>/<session_id>.jsonl
```

### 5.3 Fork Sessions

Create a new branch from an existing session:

```bash
claude -p "Try a different approach" --resume "$session_id" --fork-session
```

### 5.4 Multi-Turn with Stream-JSON

For true multi-turn within a single process:

```bash
# Combine --input-format stream-json with --output-format stream-json
claude -p --input-format stream-json --output-format stream-json --verbose
```

Then pipe JSONL messages via stdin:

```json
{
  "type": "user",
  "message": { "role": "user", "content": "First message" },
  "session_id": "default",
  "parent_tool_use_id": null
}
```

Wait for the result message, then send the next:

```json
{
  "type": "user",
  "message": { "role": "user", "content": "Follow up" },
  "session_id": "<captured_id>",
  "parent_tool_use_id": null
}
```

### 5.5 Multiple Simultaneous Sessions

Yes, you can run multiple headless sessions simultaneously -- they are independent processes. Each gets its own session ID and JSONL file. The Agent SDK handles this cleanly with separate `query()` calls.

### 5.6 Known Issues

- **Duplicate entries bug** (GitHub #5034): When using `--input-format stream-json` for multi-turn, session JSONL files accumulate duplicate entries. Each new message causes previous history to be rewritten. Context is maintained correctly despite this -- it's purely a persistence issue.
- **Hang on second message** (GitHub #3187, now resolved): Previously, sending a second stdin message could cause the process to hang. This was fixed in later versions.

---

## 6. MCP Integration in Headless Mode

### 6.1 MCP Config Format

The `--mcp-config` flag accepts a path to a JSON file:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxx"
      }
    },
    "remote-api": {
      "type": "sse",
      "url": "https://api.example.com/mcp/sse",
      "headers": {
        "Authorization": "Bearer token123"
      }
    },
    "http-api": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {}
    }
  }
}
```

### 6.2 Transport Types

| Type  | Config                     | Use Case                         |
| :---- | :------------------------- | :------------------------------- |
| stdio | `command` + `args`         | Local process, stdin/stdout      |
| SSE   | `type: "sse"` + `url`      | Cloud-hosted, server-sent events |
| HTTP  | `type: "http"` + `url`     | Cloud-hosted, request/response   |
| SDK   | `type: "sdk"` + `instance` | In-process (Agent SDK only)      |

### 6.3 Using MCP in Headless Mode

```bash
claude -p "List issues in my repo" \
  --mcp-config ./mcp.json \
  --allowedTools "mcp__github__*" \
  --output-format json
```

**Tool naming convention**: `mcp__<server-name>__<tool-name>`

Wildcards work: `mcp__github__*` allows all tools from the github server.

### 6.4 Verifying MCP Connection

In stream-json mode, the init message includes MCP server status:

```json
{
  "type": "system",
  "subtype": "init",
  "mcp_servers": [
    { "name": "github", "status": "connected" },
    { "name": "broken", "status": "failed" }
  ]
}
```

### 6.5 Can We Expose Our Own MCP Server to Headless Claude?

Yes. If you create an MCP server (stdio, SSE, or HTTP), you can configure headless Claude to connect to it. For example, an Agent Monitor MCP server could expose tools like `create_task`, `update_progress`, `log_event` that Claude could call during execution.

```json
{
  "mcpServers": {
    "agent-monitor": {
      "type": "http",
      "url": "http://localhost:9876/mcp",
      "headers": {}
    }
  }
}
```

Then:

```bash
claude -p "Fix the auth bug and log progress to agent-monitor" \
  --mcp-config ./mcp.json \
  --allowedTools "Read,Edit,Bash,mcp__agent-monitor__*"
```

---

## 7. Permission Handling & Tool Approval

### 7.1 The `--permission-prompt-tool` Flag

This is the KEY to tool approval in headless mode without the Agent SDK. It delegates permission decisions to an MCP tool:

```bash
claude -p "Refactor the codebase" \
  --mcp-config ./mcp.json \
  --permission-prompt-tool mcp__approver__check_permission
```

### 7.2 Permission Check Flow

```
┌─────────────────────────────────────────────┐
│ 1. Static rules checked first:              │
│    --allowedTools / --disallowedTools        │
│    settings.json rules                       │
│                                              │
│ 2. If rule matches: allow/deny immediately   │
│                                              │
│ 3. If no rule matches:                       │
│    Call --permission-prompt-tool MCP tool     │
│                                              │
│ 4. MCP tool returns allow/deny JSON          │
└─────────────────────────────────────────────┘
```

### 7.3 MCP Permission Tool Interface

Your MCP tool receives:

```json
{
  "tool_name": "Bash",
  "input": {
    "command": "rm -rf /tmp/test",
    "description": "Delete test directory"
  }
}
```

Your MCP tool must return JSON in the response text content:

**Allow**:

```json
{
  "behavior": "allow",
  "updatedInput": {
    "command": "rm -rf /tmp/test",
    "description": "Delete test directory"
  }
}
```

**Deny**:

```json
{
  "behavior": "deny",
  "message": "Deletion of directories is not permitted"
}
```

The `updatedInput` field is powerful -- it lets your permission server modify the tool's input before execution (e.g., sanitize paths, add constraints).

### 7.4 Implementation Example (TypeScript MCP Server)

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'approver', version: '1.0.0' });

server.tool(
  'check_permission',
  'Approve or deny tool usage requests',
  {
    tool_name: z.string(),
    input: z.object({}).passthrough(),
  },
  async ({ tool_name, input }) => {
    // Your approval logic here
    const allowed = await checkPolicy(tool_name, input);

    const payload = allowed
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `Policy denied: ${tool_name}` };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    };
  },
);
```

---

## 8. The Agent SDK (Recommended Approach)

### 8.1 Why the Agent SDK Over Raw CLI

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is the officially recommended way to programmatically control Claude Code. It provides:

1. **Native TypeScript/Python objects** instead of parsing NDJSON
2. **`canUseTool` callback** for interactive tool approval
3. **Streaming input via AsyncIterable** for multi-turn conversations
4. **`interrupt()`** to cancel mid-execution
5. **Session management** with `resume` and `forkSession`
6. **Hooks** for pre/post tool execution
7. **In-process MCP servers** (no separate process needed)
8. **V2 Preview** with simplified `send()`/`stream()` pattern

### 8.2 Installation

```bash
npm install @anthropic-ai/claude-agent-sdk
```

### 8.3 Basic One-Shot Query

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'Find and fix the bug in auth.py',
  options: {
    allowedTools: ['Read', 'Edit', 'Bash'],
    permissionMode: 'acceptEdits',
  },
})) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if ('text' in block) console.log(block.text);
      if ('name' in block) console.log(`Tool: ${block.name}`);
    }
  }
  if (message.type === 'result') {
    console.log(`Done: ${message.subtype}, Cost: $${message.total_cost_usd}`);
  }
}
```

### 8.4 Multi-Turn with Streaming Input (V1)

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

async function* generateMessages() {
  // First message
  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: 'Analyze this codebase for security issues',
    },
  };

  // Wait for some condition
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Follow-up message
  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: 'Now fix the critical vulnerabilities',
    },
  };
}

for await (const message of query({
  prompt: generateMessages(),
  options: {
    allowedTools: ['Read', 'Edit', 'Bash'],
    maxTurns: 20,
  },
})) {
  console.log(message);
}
```

### 8.5 Multi-Turn with V2 Preview (Simpler)

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';

// Create session
await using session = unstable_v2_createSession({
  model: 'claude-opus-4-6',
  allowedTools: ['Read', 'Edit', 'Bash'],
  permissionMode: 'acceptEdits',
});

// Turn 1
await session.send('Review auth.py for bugs');
for await (const msg of session.stream()) {
  if (msg.type === 'assistant') {
    const text = msg.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    console.log(text);
  }
}

// Turn 2 (same session, full context)
await session.send('Now fix the critical ones');
for await (const msg of session.stream()) {
  if (msg.type === 'result') {
    console.log('Done:', msg.result);
  }
}
```

### 8.6 Tool Approval with `canUseTool`

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'Refactor the authentication module',
  options: {
    canUseTool: async (toolName, input) => {
      console.log(`Claude wants to use: ${toolName}`);
      console.log(`Input:`, JSON.stringify(input, null, 2));

      // Custom approval logic
      if (toolName === 'Bash' && input.command.includes('rm')) {
        return {
          behavior: 'deny',
          message: 'Deletion not allowed in this context',
        };
      }

      if (toolName === 'Edit') {
        // Allow but modify the input
        return {
          behavior: 'allow',
          updatedInput: {
            ...input,
            // Could sanitize or modify the edit
          },
        };
      }

      // Default: allow
      return { behavior: 'allow', updatedInput: input };
    },
  },
})) {
  if ('result' in message) console.log(message.result);
}
```

### 8.7 Streaming with Real-Time Token Output

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'Explain the architecture of this project',
  options: {
    includePartialMessages: true,
    allowedTools: ['Read', 'Glob', 'Grep'],
  },
})) {
  if (message.type === 'stream_event') {
    const event = message.event;
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        process.stdout.write(event.delta.text);
      }
    }
  }
}
```

### 8.8 Session Management

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

let sessionId: string | undefined;

// First query: capture session ID
for await (const message of query({
  prompt: 'Read the authentication module',
  options: { allowedTools: ['Read', 'Glob'] },
})) {
  if (message.type === 'system' && message.subtype === 'init') {
    sessionId = message.session_id;
    console.log(`Session: ${sessionId}`);
  }
}

// Resume with full context
for await (const message of query({
  prompt: 'Now find all places that call it',
  options: { resume: sessionId },
})) {
  if ('result' in message) console.log(message.result);
}

// Fork the session (explore different approach)
for await (const message of query({
  prompt: 'Try a completely different approach',
  options: { resume: sessionId, forkSession: true },
})) {
  // This creates a NEW session branching from the original
}
```

### 8.9 MCP in the Agent SDK

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'List recent issues in my repo',
  options: {
    mcpServers: {
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
      },
    },
    allowedTools: ['mcp__github__list_issues'],
  },
})) {
  if (message.type === 'system' && message.subtype === 'init') {
    console.log('MCP servers:', message.mcp_servers);
  }
  if (message.type === 'result' && message.subtype === 'success') {
    console.log(message.result);
  }
}
```

### 8.10 In-Process Custom MCP Tools

```typescript
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Define a custom tool
const logProgressTool = tool(
  'log_progress',
  'Log agent progress to monitoring system',
  { message: z.string(), percentage: z.number() },
  async ({ message, percentage }) => {
    console.log(`[PROGRESS ${percentage}%] ${message}`);
    return { content: [{ type: 'text', text: 'Progress logged' }] };
  },
);

// Create in-process MCP server
const monitorServer = createSdkMcpServer({
  name: 'monitor',
  tools: [logProgressTool],
});

// Use it
for await (const message of query({
  prompt: 'Fix all bugs and log your progress',
  options: {
    mcpServers: { monitor: monitorServer },
    allowedTools: ['Read', 'Edit', 'Bash', 'mcp__monitor__*'],
  },
})) {
  // ...
}
```

### 8.11 Hooks

```typescript
import { query, HookCallback } from '@anthropic-ai/claude-agent-sdk';

const auditLog: HookCallback = async (input) => {
  if (input.hook_event_name === 'PostToolUse') {
    console.log(`[AUDIT] Tool: ${input.tool_name}, Input: ${JSON.stringify(input.tool_input)}`);
  }
  return {};
};

for await (const message of query({
  prompt: 'Refactor utils.py',
  options: {
    permissionMode: 'acceptEdits',
    hooks: {
      PostToolUse: [{ hooks: [auditLog] }],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            async (input) => {
              // Block dangerous commands
              const cmd = (input as any).tool_input?.command || '';
              if (cmd.includes('rm -rf /')) {
                return { decision: 'block', reason: 'Dangerous command blocked' };
              }
              return { continue: true };
            },
          ],
        },
      ],
    },
  },
})) {
  if ('result' in message) console.log(message.result);
}
```

### 8.12 Available Hook Events

| Hook Event           | When It Fires                                               |
| :------------------- | :---------------------------------------------------------- |
| `PreToolUse`         | Before a tool executes                                      |
| `PostToolUse`        | After a tool executes successfully                          |
| `PostToolUseFailure` | After a tool fails                                          |
| `Notification`       | When agent sends a notification                             |
| `UserPromptSubmit`   | When a user prompt is submitted                             |
| `SessionStart`       | When a session starts                                       |
| `SessionEnd`         | When a session ends                                         |
| `Stop`               | When agent stops                                            |
| `SubagentStart`      | When a subagent is spawned                                  |
| `SubagentStop`       | When a subagent finishes                                    |
| `PreCompact`         | Before context compaction                                   |
| `PermissionRequest`  | When a permission is requested (for external notifications) |

---

## 9. Real-World Usage Examples

### 9.1 CI/CD Pipeline: Automated Code Review

```bash
#!/bin/bash
# .github/scripts/review.sh

gh pr diff "$PR_NUMBER" | claude -p \
  --append-system-prompt "You are a security engineer. Review for vulnerabilities." \
  --allowedTools "Read,Grep,Glob" \
  --max-budget-usd 2.00 \
  --output-format json | jq -r '.result'
```

### 9.2 Automated Commit Creation

```bash
claude -p "Look at staged changes and create an appropriate commit" \
  --allowedTools "Bash(git diff *),Bash(git log *),Bash(git status *),Bash(git commit *)"
```

### 9.3 Multi-Step Review Pipeline (CLI)

```bash
# Step 1: Review
session_id=$(claude -p "Review this codebase for performance issues" \
  --output-format json | jq -r '.session_id')

# Step 2: Focus on specific area
claude -p "Now focus on the database queries" --resume "$session_id"

# Step 3: Generate report
claude -p "Generate a summary of all issues found" --resume "$session_id"
```

### 9.4 Stream-JSON Pipeline (Agent Chaining)

```bash
# Chain Claude instances via stream-json
claude -p "Analyze the auth module" --output-format stream-json | \
  claude -p --input-format stream-json --output-format stream-json \
    "Based on the analysis, write unit tests" | \
  claude -p --input-format stream-json "Summarize what was done"
```

### 9.5 Node.js Bidirectional Communication (Raw CLI)

```typescript
import { spawn } from 'child_process';
import { createInterface } from 'readline';

async function runClaudeHeadless(initialPrompt: string) {
  const proc = spawn(
    'claude',
    [
      '-p',
      initialPrompt,
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const rl = createInterface({ input: proc.stdout! });
  let sessionId: string | null = null;

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);

      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            sessionId = msg.session_id;
            console.log(`Session started: ${sessionId}`);
            console.log(`Tools: ${msg.tools.join(', ')}`);
            console.log(`Model: ${msg.model}`);
          }
          break;

        case 'stream_event':
          if (msg.event?.type === 'content_block_delta') {
            if (msg.event.delta?.type === 'text_delta') {
              process.stdout.write(msg.event.delta.text);
            }
          }
          break;

        case 'assistant':
          // Complete assistant message
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_use') {
              console.log(`\n[Tool: ${block.name}]`);
            }
          }
          break;

        case 'result':
          console.log(`\n--- Result (${msg.subtype}) ---`);
          console.log(`Cost: $${msg.total_cost_usd}`);
          console.log(`Turns: ${msg.num_turns}`);

          // Send follow-up message
          if (sessionId) {
            const followUp = JSON.stringify({
              type: 'user',
              message: { role: 'user', content: 'Now fix the issues you found' },
              session_id: sessionId,
              parent_tool_use_id: null,
            });
            proc.stdin!.write(followUp + '\n');
          }
          break;
      }
    } catch (e) {
      // Non-JSON output, ignore
    }
  });

  proc.stderr?.on('data', (data) => {
    console.error(`[stderr] ${data}`);
  });

  proc.on('close', (code) => {
    console.log(`Claude exited with code ${code}`);
  });
}

runClaudeHeadless('Review auth.py for security vulnerabilities');
```

### 9.6 Full Agent SDK Application

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

interface TaskResult {
  sessionId: string;
  result: string;
  cost: number;
  turns: number;
}

async function runAgent(
  prompt: string,
  options: {
    resume?: string;
    maxBudget?: number;
    maxTurns?: number;
    onToolUse?: (name: string, input: any) => Promise<boolean>;
    onProgress?: (text: string) => void;
  } = {},
): Promise<TaskResult> {
  let sessionId = '';
  let result = '';
  let cost = 0;
  let turns = 0;

  for await (const message of query({
    prompt,
    options: {
      resume: options.resume,
      maxBudgetUsd: options.maxBudget,
      maxTurns: options.maxTurns,
      includePartialMessages: true,
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      canUseTool: options.onToolUse
        ? async (toolName, input) => {
            const allowed = await options.onToolUse!(toolName, input);
            return allowed
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'Denied by policy' };
          }
        : undefined,
    },
  })) {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          sessionId = message.session_id;
        }
        break;

      case 'stream_event':
        if (
          message.event.type === 'content_block_delta' &&
          message.event.delta.type === 'text_delta'
        ) {
          options.onProgress?.(message.event.delta.text);
        }
        break;

      case 'result':
        if (message.subtype === 'success') {
          result = message.result;
        }
        cost = message.total_cost_usd;
        turns = message.num_turns;
        break;
    }
  }

  return { sessionId, result, cost, turns };
}

// Usage
async function main() {
  // Step 1: Initial review
  const review = await runAgent('Review the auth module for security issues', {
    maxBudget: 5.0,
    maxTurns: 10,
    onProgress: (text) => process.stdout.write(text),
    onToolUse: async (name, input) => {
      // Auto-approve reads, require approval for writes
      if (['Read', 'Glob', 'Grep'].includes(name)) return true;
      console.log(`\nApprove ${name}? (auto-approving for demo)`);
      return true;
    },
  });
  console.log(`\n\nReview complete. Cost: $${review.cost}`);

  // Step 2: Fix issues (resume same session)
  const fix = await runAgent('Fix the critical vulnerabilities you identified', {
    resume: review.sessionId,
    maxBudget: 3.0,
    onProgress: (text) => process.stdout.write(text),
  });
  console.log(`\n\nFix complete. Cost: $${fix.cost}`);
}

main();
```

---

## 10. Comparison: CLI vs Agent SDK vs Direct API

### 10.1 Feature Matrix

| Feature                           | CLI (`claude -p`)             | Agent SDK              | Anthropic Messages API  |
| :-------------------------------- | :---------------------------- | :--------------------- | :---------------------- |
| Built-in tools (Read, Edit, Bash) | Yes                           | Yes                    | No (must implement)     |
| Tool execution                    | Automatic                     | Automatic              | Manual (your code)      |
| Session persistence               | Yes                           | Yes                    | No (must implement)     |
| Context compaction                | Automatic                     | Automatic              | No                      |
| Multi-turn conversations          | Via --continue/--resume       | Native streaming input | Manual message history  |
| Tool approval                     | --permission-prompt-tool      | canUseTool callback    | N/A (you execute tools) |
| Streaming                         | stream-json NDJSON            | Native async iterators | SSE events              |
| MCP servers                       | --mcp-config                  | mcpServers option      | No                      |
| Hooks                             | settings.json + shell scripts | Native callbacks       | No                      |
| Subagents                         | --agents JSON                 | agents option          | No                      |
| Custom system prompt              | --system-prompt               | systemPrompt option    | system parameter        |
| Budget limits                     | --max-budget-usd              | maxBudgetUsd           | No (manual tracking)    |
| Turn limits                       | --max-turns                   | maxTurns               | No                      |
| Structured output                 | --json-schema                 | outputFormat           | response_format         |
| Image input                       | Via stdin content blocks      | Via message content    | Via messages            |
| Sandbox                           | Via settings                  | sandbox option         | N/A                     |

### 10.2 When to Use Each

| Use Case                    | Best Choice            | Why                                |
| :-------------------------- | :--------------------- | :--------------------------------- |
| Shell scripts & CI/CD       | CLI (`claude -p`)      | Simple, no code dependencies       |
| Production Node.js apps     | Agent SDK (TypeScript) | Native types, callbacks, streaming |
| Production Python apps      | Agent SDK (Python)     | Same as TypeScript                 |
| Custom tool implementations | Anthropic Messages API | Full control over tool execution   |
| Agent chaining/pipelines    | CLI with stream-json   | Unix pipe philosophy               |
| Interactive approval flows  | Agent SDK              | canUseTool callback                |
| One-off automation          | CLI                    | Quick and simple                   |

### 10.3 Architecture Decision

For our use case (programmatic control from a Node.js app with bidirectional communication):

**The Agent SDK is the clear winner.** It provides:

- Native TypeScript objects instead of parsing NDJSON
- `canUseTool` callback for tool approval (no MCP server needed)
- AsyncIterable/V2 `send()`/`stream()` for multi-turn conversations
- `interrupt()` for cancellation
- `setPermissionMode()` for dynamic permission changes
- Proper error handling with typed result messages
- In-process MCP servers for custom tools

---

## 11. Security Considerations

### 11.1 Permission Mode Risks

| Mode                | Risk Level | Notes                                                  |
| :------------------ | :--------- | :----------------------------------------------------- |
| `default`           | Low        | Requires explicit approval for tools                   |
| `acceptEdits`       | Medium     | Auto-approves file edits (mkdir, rm, mv, cp)           |
| `bypassPermissions` | HIGH       | All tools run without prompts; propagates to subagents |
| `plan`              | Minimal    | No tool execution at all                               |

### 11.2 Subagent Inheritance Warning

When using `bypassPermissions`, ALL subagents inherit this mode and it cannot be overridden. Subagents may have different system prompts and less constrained behavior. This effectively grants full, autonomous system access.

### 11.3 Sandbox Configuration

The Agent SDK supports sandboxing:

```typescript
options: {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    network: {
      allowLocalBinding: true
    }
  }
}
```

Key sandbox settings:

- `enabled`: Enable sandbox for command execution
- `autoAllowBashIfSandboxed`: Auto-approve bash when sandboxed
- `excludedCommands`: Commands that always bypass sandbox
- `allowUnsandboxedCommands`: Allow model to request unsandboxed execution
- `network.allowLocalBinding`: Allow processes to bind local ports
- `network.allowUnixSockets`: Specific Unix sockets to allow

### 11.4 Best Practices

1. **Never use `bypassPermissions` in production** unless in fully isolated containers
2. **Use `--allowedTools` with specific patterns**: `"Bash(git diff *)"` not `"Bash"`
3. **Set `--max-budget-usd`** to prevent runaway costs
4. **Set `--max-turns`** to prevent infinite loops
5. **Use `canUseTool`** callback for interactive approval when possible
6. **Audit tool usage** with PostToolUse hooks
7. **Use sandbox mode** for untrusted codebases
8. **Don't expose secrets** in system prompts or tool inputs

---

## 12. Reference Tables

### 12.1 All CLI Flags for Headless Mode

| Flag                          | Required           | Print Mode | Interactive |
| :---------------------------- | :----------------- | :--------- | :---------- |
| `-p, --print`                 | Yes (for headless) | N/A        | N/A         |
| `--output-format`             | No                 | Yes        | No          |
| `--input-format`              | No                 | Yes        | No          |
| `--include-partial-messages`  | No                 | Yes        | No          |
| `--replay-user-messages`      | No                 | Yes        | No          |
| `--verbose`                   | No                 | Yes        | Yes         |
| `--allowedTools`              | No                 | Yes        | Yes         |
| `--disallowedTools`           | No                 | Yes        | Yes         |
| `--tools`                     | No                 | Yes        | Yes         |
| `--permission-mode`           | No                 | Yes        | Yes         |
| `--permission-prompt-tool`    | No                 | Yes        | No          |
| `--max-budget-usd`            | No                 | Yes        | No          |
| `--max-turns`                 | No                 | Yes        | No          |
| `--model`                     | No                 | Yes        | Yes         |
| `--fallback-model`            | No                 | Yes        | No          |
| `--continue, -c`              | No                 | Yes        | Yes         |
| `--resume, -r`                | No                 | Yes        | Yes         |
| `--session-id`                | No                 | Yes        | Yes         |
| `--fork-session`              | No                 | Yes        | Yes         |
| `--no-session-persistence`    | No                 | Yes        | No          |
| `--mcp-config`                | No                 | Yes        | Yes         |
| `--strict-mcp-config`         | No                 | Yes        | Yes         |
| `--system-prompt`             | No                 | Yes        | Yes         |
| `--system-prompt-file`        | No                 | Yes        | No          |
| `--append-system-prompt`      | No                 | Yes        | Yes         |
| `--append-system-prompt-file` | No                 | Yes        | No          |
| `--json-schema`               | No                 | Yes        | No          |
| `--agents`                    | No                 | Yes        | Yes         |
| `--add-dir`                   | No                 | Yes        | Yes         |
| `--debug`                     | No                 | Yes        | Yes         |

### 12.2 All Message Types (Output)

| type           | subtype                  | When                        | Contains                                 |
| :------------- | :----------------------- | :-------------------------- | :--------------------------------------- |
| `system`       | `init`                   | First message               | session_id, tools, model, mcp_servers    |
| `system`       | `compact_boundary`       | After compaction            | compact_metadata                         |
| `assistant`    | --                       | After each response         | message.content (text + tool_use blocks) |
| `user`         | --                       | When --replay-user-messages | message.content                          |
| `stream_event` | --                       | When --include-partial      | event (raw API stream event)             |
| `result`       | `success`                | Task complete               | result, cost, usage, turns               |
| `result`       | `error_max_turns`        | Turn limit hit              | errors array                             |
| `result`       | `error_during_execution` | Runtime error               | errors array                             |
| `result`       | `error_max_budget_usd`   | Budget exceeded             | errors array                             |

### 12.3 Stream Event Types (Within stream_event)

| event.type            | Description                                          |
| :-------------------- | :--------------------------------------------------- |
| `message_start`       | New message begins                                   |
| `content_block_start` | New text or tool_use block begins                    |
| `content_block_delta` | Incremental content (text_delta or input_json_delta) |
| `content_block_stop`  | Block complete                                       |
| `message_delta`       | Message-level update (stop_reason, usage)            |
| `message_stop`        | Message complete                                     |

### 12.4 Built-in Tools

| Tool             | Description                 | Auto-approved in acceptEdits? |
| :--------------- | :-------------------------- | :---------------------------- |
| Read             | Read files                  | No (but generally safe)       |
| Write            | Create/overwrite files      | Yes                           |
| Edit             | String replacement in files | Yes                           |
| Bash             | Execute shell commands      | No (except filesystem ops)    |
| Glob             | Find files by pattern       | No                            |
| Grep             | Search file contents        | No                            |
| WebSearch        | Search the web              | No                            |
| WebFetch         | Fetch URL content           | No                            |
| Task             | Spawn subagent              | No                            |
| AskUserQuestion  | Ask clarifying questions    | Special handling              |
| TodoWrite        | Manage task lists           | No                            |
| NotebookEdit     | Edit Jupyter notebooks      | Yes                           |
| ExitPlanMode     | Exit plan mode              | Special handling              |
| KillBash         | Kill background shell       | No                            |
| BashOutput       | Get background shell output | No                            |
| ListMcpResources | List MCP resources          | No                            |
| ReadMcpResource  | Read MCP resource           | No                            |

### 12.5 Agent SDK Options (TypeScript)

| Option                   | Type                      | Default         | Description                |
| :----------------------- | :------------------------ | :-------------- | :------------------------- |
| `allowedTools`           | `string[]`                | All tools       | Tools that auto-execute    |
| `disallowedTools`        | `string[]`                | `[]`            | Tools removed from context |
| `tools`                  | `string[] \| preset`      | undefined       | Restrict available tools   |
| `permissionMode`         | `PermissionMode`          | `'default'`     | Permission mode            |
| `canUseTool`             | `CanUseTool`              | undefined       | Tool approval callback     |
| `resume`                 | `string`                  | undefined       | Session ID to resume       |
| `continue`               | `boolean`                 | `false`         | Continue most recent       |
| `forkSession`            | `boolean`                 | `false`         | Fork when resuming         |
| `model`                  | `string`                  | Default         | Model to use               |
| `maxBudgetUsd`           | `number`                  | unlimited       | Max spend                  |
| `maxTurns`               | `number`                  | unlimited       | Max agentic turns          |
| `maxThinkingTokens`      | `number`                  | undefined       | Max thinking tokens        |
| `includePartialMessages` | `boolean`                 | `false`         | Stream token events        |
| `mcpServers`             | `Record<string, config>`  | `{}`            | MCP server configs         |
| `systemPrompt`           | `string \| preset`        | undefined       | System prompt              |
| `hooks`                  | `Record<event, matchers>` | `{}`            | Hook callbacks             |
| `agents`                 | `Record<string, def>`     | undefined       | Subagent definitions       |
| `cwd`                    | `string`                  | `process.cwd()` | Working directory          |
| `abortController`        | `AbortController`         | new             | For cancellation           |
| `sandbox`                | `SandboxSettings`         | undefined       | Sandbox config             |
| `settingSources`         | `SettingSource[]`         | `[]`            | Which settings to load     |
| `plugins`                | `SdkPluginConfig[]`       | `[]`            | Plugin configs             |
| `outputFormat`           | `{ type, schema }`        | undefined       | Structured output          |
| `betas`                  | `SdkBeta[]`               | `[]`            | Beta features              |

---

## 13. Sources

### Official Documentation

- [Run Claude Code programmatically (Headless)](https://code.claude.com/docs/en/headless)
- [CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent SDK Streaming vs Single Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Agent SDK Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Agent SDK Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [Agent SDK User Input & Tool Approval](https://platform.claude.com/docs/en/agent-sdk/user-input)
- [Agent SDK MCP Integration](https://platform.claude.com/docs/en/agent-sdk/mcp)

### GitHub Issues & Discussions

- [#3187: stream-json input hang bug](https://github.com/anthropics/claude-code/issues/3187)
- [#5034: Duplicate entries in session JSONL with stream-json](https://github.com/anthropics/claude-code/issues/5034)
- [#1175: permission-prompt-tool documentation request](https://github.com/anthropics/claude-code/issues/1175)
- [#15511: Stream partial JSON tokens feature request](https://github.com/anthropics/claude-code/issues/15511)

### Community Resources

- [Claude Code Headless - Adriano Melo](https://adrianomelo.com/posts/claude-code-headless.html)
- [claude-flow Stream-JSON Chaining Wiki](https://github.com/ruvnet/claude-flow/wiki/Stream-Chaining)
- [claude-flow Non-Interactive Mode Wiki](https://github.com/ruvnet/claude-flow/wiki/Non-Interactive-Mode)
- [claude-clean: Terminal parser for streaming JSON](https://github.com/ariel-frischer/claude-clean)
- [headless-claude: Production patterns](https://github.com/mjmirza/headless-claude)
- [Claude Code SDK Demos](https://github.com/anthropics/claude-agent-sdk-demos)
- [Permission-prompt-tool guide](https://www.vibesparking.com/en/blog/ai/claude-code/docs/cli/2025-08-28-outsourcing-permissions-with-claude-code-permission-prompt-tool/)

### SDK Repositories

- [claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
- [claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python)

---

## Appendix A: Quick Decision Matrix

```
Need to control Claude Code programmatically?
│
├─ From a shell script or CI/CD?
│  └─ USE: claude -p with --output-format json
│
├─ From Node.js with full bidirectional control?
│  └─ USE: @anthropic-ai/claude-agent-sdk (TypeScript)
│     ├─ Simple one-shot: query({ prompt: "..." })
│     ├─ Multi-turn: V2 createSession() + send()/stream()
│     ├─ Tool approval: canUseTool callback
│     └─ Custom tools: createSdkMcpServer()
│
├─ From Python?
│  └─ USE: claude-agent-sdk (Python)
│
├─ Need pipe-based agent chaining?
│  └─ USE: CLI with --output-format stream-json | claude -p --input-format stream-json
│
└─ Need custom tool implementations from scratch?
   └─ USE: Anthropic Messages API directly
```

## Appendix B: Naming Note

The Claude Code SDK has been **renamed to Claude Agent SDK** as of late 2025. References to `claude-code-sdk` in older documentation refer to the same package now called `claude-agent-sdk` (Python) or `@anthropic-ai/claude-agent-sdk` (TypeScript).
