# Bidirectional Communication with AI CLI Agents from Node.js

**Research Date**: 2026-02-17
**Purpose**: Architecture research for "Agent Monitor" -- a web-based task manager that manages AI CLI agents (Claude Code, Gemini CLI, Codex CLI) with bidirectional communication.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Claude Code: Stream-JSON Bidirectional Mode](#2-claude-code-stream-json-bidirectional-mode)
3. [Claude Agent SDK (TypeScript)](#3-claude-agent-sdk-typescript)
4. [Gemini CLI: Interactive Management](#4-gemini-cli-interactive-management)
5. [Codex CLI: App-Server Protocol](#5-codex-cli-app-server-protocol)
6. [node-pty + xterm.js: Web Terminal Bridge](#6-node-pty--xtermjs-web-terminal-bridge)
7. [tmux as Process Isolation Layer](#7-tmux-as-process-isolation-layer)
8. [Existing Orchestration Implementations](#8-existing-orchestration-implementations)
9. [Comparison Table](#9-comparison-table)
10. [Architecture Recommendations](#10-architecture-recommendations)
11. [Sources](#11-sources)

---

## 1. Executive Summary

Each AI CLI agent has a different level of bidirectional support:

| Agent | Native Bidirectional | Recommended Approach |
|-------|---------------------|---------------------|
| **Claude Code** | YES -- Agent SDK (TypeScript/Python) with streaming input mode | Use `@anthropic-ai/claude-agent-sdk` with `AsyncIterable<SDKUserMessage>` or V2 `send()`/`stream()` |
| **Codex CLI** | YES -- `codex app-server` JSON-RPC over stdio | Use `codex app-server` subprocess with full JSON-RPC 2.0 bidirectional protocol |
| **Gemini CLI** | NO -- headless mode is one-shot only | Use tmux sessions + `tmux send-keys` / `tmux capture-pane` for pseudo-bidirectional |

For web terminal access (manual interaction via browser), the universal approach is:
**tmux sessions + node-pty + xterm.js + WebSocket**

---

## 2. Claude Code: Stream-JSON Bidirectional Mode

### 2.1 CLI-Level stream-json Protocol

Claude Code supports `--input-format stream-json` and `--output-format stream-json` for machine-to-machine communication via NDJSON (newline-delimited JSON).

#### Invocation

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --allowedTools "Bash,Read,Edit,Grep,Glob"
```

Key flags:
- `--input-format stream-json` -- Accept NDJSON user messages via stdin
- `--output-format stream-json` -- Emit NDJSON events to stdout
- `--verbose` -- Required for stream-json output to include full details
- `--include-partial-messages` -- Include token-level streaming events (type: `stream_event`)

#### Output Message Types (stdout, CLI to App)

Each line is a complete JSON object. The `type` field identifies the message:

| Type | Description |
|------|-------------|
| `system` | Session initialization (sent once at start). Subtype `init` includes `session_id`, `model`, `tools[]`, `mcp_servers[]`, `permissionMode` |
| `assistant` | Claude's response messages. Content is an array of `text` and `tool_use` blocks |
| `user` | Tool results being returned to Claude (internal messages) |
| `result` | Final completion. Subtype `success` includes `result`, `duration_ms`, `total_cost_usd`, `usage`. Error subtypes: `error_max_turns`, `error_during_execution`, `error_max_budget_usd` |
| `stream_event` | Token-level partial updates (only with `--include-partial-messages`). Contains `event.delta.type` and `event.delta.text` for text streaming |

#### Output Schemas

**System Init Message:**
```json
{
  "type": "system",
  "subtype": "init",
  "uuid": "...",
  "session_id": "...",
  "apiKeySource": "user",
  "cwd": "/path/to/project",
  "tools": ["Bash", "Read", "Edit", "Grep", "Glob"],
  "mcp_servers": [{"name": "server1", "status": "connected"}],
  "model": "claude-opus-4-6",
  "permissionMode": "default"
}
```

**Assistant Message:**
```json
{
  "type": "assistant",
  "uuid": "...",
  "session_id": "...",
  "message": {
    "role": "assistant",
    "content": [
      {"type": "text", "text": "I'll analyze..."},
      {"type": "tool_use", "id": "toolu_...", "name": "Read", "input": {"file_path": "/src/auth.ts"}}
    ]
  },
  "parent_tool_use_id": null
}
```

**Result Message:**
```json
{
  "type": "result",
  "subtype": "success",
  "uuid": "...",
  "session_id": "...",
  "duration_ms": 15230,
  "duration_api_ms": 12100,
  "is_error": false,
  "num_turns": 3,
  "result": "Analysis complete. Found 2 security issues...",
  "total_cost_usd": 0.0234,
  "usage": {
    "input_tokens": 15000,
    "output_tokens": 2500,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 12000
  }
}
```

#### Input Message Format (stdin, App to CLI)

When using `--input-format stream-json`, user messages are sent as NDJSON on stdin:

```json
{"type":"user","message":{"role":"user","content":"Analyze this codebase for security issues"}}
```

For follow-up messages during a running session:
```json
{"type":"user","message":{"role":"user","content":"Now focus on the database queries"}}
```

**Important caveat**: The `--input-format stream-json` mode via CLI has been reported to have stability issues (GitHub issue #3187 -- process hanging after first turn). The recommended approach is to use the Agent SDK (Section 3) instead of raw CLI stdin for production bidirectional communication.

#### Stream Chaining (Pipeline Pattern)

Multiple Claude instances can be piped together:

```bash
claude -p --output-format stream-json "Analyze dataset" | \
  claude -p --input-format stream-json --output-format stream-json "Process results" | \
  claude -p --input-format stream-json "Generate report"
```

This is a one-directional pipeline, not true bidirectional, but useful for multi-agent workflows.

#### Session Resume

Use `--resume` with a session ID for multi-turn conversations across invocations:

```bash
# First invocation
SESSION_ID=$(claude -p "Start analysis" --output-format json | jq -r '.session_id')

# Follow-up (new process, same session)
claude -p "Now check error handling" --resume "$SESSION_ID"
```

### 2.2 The `--replay-user-messages` Pattern

When resuming a session, Claude Code can replay previous user messages for context. Combined with `--input-format stream-json`, this enables resume-turn persistence where the user prompt is sent via stdin while preserving the full conversation across resume calls.

---

## 3. Claude Agent SDK (TypeScript)

The Agent SDK is the **recommended** approach for programmatic bidirectional communication with Claude Code. It wraps the CLI subprocess and provides a clean TypeScript/Python API.

### 3.1 Installation

```bash
npm install @anthropic-ai/claude-agent-sdk
```

### 3.2 V1 API: `query()` with AsyncIterable (Streaming Input)

The V1 API uses an async generator pattern. The `prompt` parameter accepts `string | AsyncIterable<SDKUserMessage>`. The `AsyncIterable` form keeps stdin open for sending multiple messages:

```typescript
import {
  query,
  type SDKUserMessage,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";

// Create an async generator that yields user messages on demand
async function* createMessageStream(): AsyncGenerator<SDKUserMessage> {
  // First message -- sent immediately
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Analyze this codebase for security issues"
    }
  } as SDKUserMessage;

  // Simulate waiting for user to type a follow-up
  // In practice, this would await a queue, event emitter, or similar
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Follow-up message sent to the RUNNING agent
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Now focus specifically on SQL injection vulnerabilities"
    }
  } as SDKUserMessage;
}

// Create the query with streaming input
const q = query({
  prompt: createMessageStream(),
  options: {
    model: "claude-opus-4-6",
    maxTurns: 20,
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    includePartialMessages: true,  // for token-level streaming
    cwd: "/path/to/project"
  }
});

// Process streaming output
for await (const message of q) {
  switch (message.type) {
    case "system":
      console.log("Session started:", message.session_id);
      break;
    case "assistant":
      // Process assistant messages (text + tool use)
      for (const block of message.message.content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
        }
      }
      break;
    case "result":
      console.log("Done:", message.result);
      break;
    case "stream_event":
      // Token-level streaming
      if (message.event?.delta?.type === "text_delta") {
        process.stdout.write(message.event.delta.text);
      }
      break;
  }
}
```

#### Key Pattern: Queue-Based Message Injection

For a web application, use an event emitter or async queue to push messages from HTTP/WebSocket handlers into the generator:

```typescript
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "events";

class AgentSession {
  private messageEmitter = new EventEmitter();
  private sessionId: string | undefined;
  private queryInstance: ReturnType<typeof query> | undefined;

  async start(initialPrompt: string) {
    const self = this;

    async function* messageStream(): AsyncGenerator<SDKUserMessage> {
      // Yield initial prompt
      yield {
        type: "user",
        message: { role: "user", content: initialPrompt }
      } as SDKUserMessage;

      // Keep the generator open, yielding messages as they arrive
      while (true) {
        const message: string = await new Promise(resolve => {
          self.messageEmitter.once("user-message", resolve);
        });

        if (message === "__CLOSE__") return;

        yield {
          type: "user",
          message: { role: "user", content: message }
        } as SDKUserMessage;
      }
    }

    this.queryInstance = query({
      prompt: messageStream(),
      options: {
        allowedTools: ["Read", "Edit", "Bash", "Grep", "Glob"],
        includePartialMessages: true
      }
    });

    // Process output in background
    for await (const msg of this.queryInstance) {
      if (msg.session_id) this.sessionId = msg.session_id;
      this.handleMessage(msg);
    }
  }

  // Called from web handler to send follow-up message
  sendMessage(text: string) {
    this.messageEmitter.emit("user-message", text);
  }

  // Interrupt the running agent
  async interrupt() {
    await this.queryInstance?.interrupt();
  }

  close() {
    this.messageEmitter.emit("user-message", "__CLOSE__");
  }

  private handleMessage(msg: any) {
    // Emit to WebSocket clients, store in DB, etc.
  }
}
```

#### Additional Query Methods

The `Query` object returned by `query()` has these methods (only available in streaming input mode):

| Method | Description |
|--------|-------------|
| `interrupt()` | Interrupts the currently running turn |
| `rewindFiles(uuid)` | Restores files to state at a specific message (requires `enableFileCheckpointing: true`) |
| `setPermissionMode(mode)` | Changes permission mode mid-session |
| `setModel(model)` | Switches model mid-session |
| `setMaxThinkingTokens(n)` | Adjusts thinking budget |
| `supportedCommands()` | Lists available slash commands |
| `supportedModels()` | Lists available models |
| `mcpServerStatus()` | Returns MCP server connection status |
| `accountInfo()` | Returns account info |

### 3.3 V2 API (Preview): `send()` / `stream()` Pattern

The V2 API simplifies multi-turn conversations with an explicit send/stream cycle:

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";

// Create a persistent session
await using session = unstable_v2_createSession({
  model: "claude-opus-4-6"
});

// Turn 1: Send message and stream response
await session.send("Analyze this codebase for security issues");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    const text = msg.message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
    console.log(text);
  }
}

// Turn 2: Send follow-up (session remembers context)
await session.send("Now check for SQL injection specifically");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    const text = msg.message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
    console.log(text);
  }
}
```

#### Session Resume Across Restarts

```typescript
// Save session ID to database
const session1 = unstable_v2_createSession({ model: "claude-opus-4-6" });
await session1.send("Remember: the auth module uses JWT");
let sessionId: string;
for await (const msg of session1.stream()) {
  sessionId = msg.session_id;
}
session1.close();

// Later: resume from stored session ID
await using session2 = unstable_v2_resumeSession(sessionId!, {
  model: "claude-opus-4-6"
});
await session2.send("What auth approach did I mention?");
for await (const msg of session2.stream()) {
  // Claude remembers the JWT context
}
```

#### V2 API Reference

```typescript
interface Session {
  send(message: string): Promise<void>;
  stream(): AsyncGenerator<SDKMessage>;
  close(): void;
}

// Functions:
unstable_v2_createSession(options): Session
unstable_v2_resumeSession(sessionId: string, options): Session
unstable_v2_prompt(prompt: string, options): Promise<Result>  // one-shot
```

**V2 Status**: Preview/unstable. Not all V1 features are available (e.g., no `forkSession`). The `unstable_` prefix indicates APIs may change.

### 3.4 Tool Approval Handling

The SDK supports custom permission handling via `canUseTool`:

```typescript
const q = query({
  prompt: messageStream(),
  options: {
    permissionMode: "default",
    canUseTool: async (toolName, input, { signal, suggestions }) => {
      // Forward to web UI for user approval
      const approved = await askUserViaWebSocket(toolName, input);
      if (approved) {
        return { behavior: "allow", updatedInput: input };
      } else {
        return {
          behavior: "deny",
          message: "User denied permission"
        };
      }
    }
  }
});
```

### 3.5 Hooks for Event-Driven Integration

Hooks allow injecting logic at various lifecycle points:

```typescript
const q = query({
  prompt: "Fix the tests",
  options: {
    hooks: {
      PreToolUse: [{
        matcher: "Bash",
        hooks: [async (input) => {
          console.log("About to run:", input.tool_input.command);
          return { continue: true };
        }]
      }],
      Notification: [{
        hooks: [async (input) => {
          // Forward notification to web UI
          broadcastToWebSocket({
            type: "notification",
            message: input.message
          });
          return { continue: true };
        }]
      }],
      Stop: [{
        hooks: [async (input) => {
          // Agent finished -- notify UI
          broadcastToWebSocket({ type: "agent-stopped" });
          return { continue: true };
        }]
      }]
    }
  }
});
```

Available hook events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`.

---

## 4. Gemini CLI: Interactive Management

### 4.1 Current State

Gemini CLI does **not** have a native bidirectional protocol like Claude's Agent SDK or Codex's app-server. The headless mode is strictly one-shot:

```bash
# One-shot headless mode
gemini -p "Analyze this code" --output-format json

# Pipe stdin
echo "Review this file" | gemini --output-format json
```

#### Headless Output Formats

**JSON** (`--output-format json`):
```json
{
  "response": "The code analysis shows...",
  "stats": {
    "api_calls": [
      {
        "model": "gemini-2.5-pro",
        "input_tokens": 5000,
        "output_tokens": 800
      }
    ],
    "tool_executions": {"accept": 3, "reject": 0}
  }
}
```

**Streaming JSON** (`--output-format stream-json`):
NDJSON events with types: `init`, `message`, `tool_use`, `tool_result`, `error`, `result`.

```json
{"type":"init","session_id":"...","model":"gemini-2.5-pro"}
{"type":"message","role":"assistant","content":"I'll analyze..."}
{"type":"tool_use","name":"read_file","input":{"path":"src/auth.ts"}}
{"type":"tool_result","output":"file contents..."}
{"type":"result","response":"Analysis complete","stats":{}}
```

**Exit codes**: 0 (success), 1 (error), 42 (input error), 53 (turn limit exceeded).

### 4.2 Limitations for Bidirectional Use

- No `--input-format stream-json` equivalent
- No session resume by ID
- No stdin message injection during execution
- No native SDK for programmatic multi-turn

There is an open feature request (GitHub issue #8203) to add `stream-json` input format to Gemini CLI, but it has not been implemented as of February 2026.

### 4.3 Recommended Approach: tmux Wrapper

The most practical approach for Gemini is to manage it through tmux sessions:

```typescript
import { execSync } from "child_process";

class GeminiTmuxSession {
  private sessionName: string;

  constructor(id: string) {
    this.sessionName = `gemini-${id}`;
  }

  async start(): Promise<void> {
    // Create a detached tmux session running Gemini in interactive mode
    execSync(
      `tmux new-session -d -s "${this.sessionName}" -x 200 -y 50 "gemini"`
    );
    // Wait for Gemini to initialize
    await this.waitForPrompt();
  }

  async sendMessage(message: string): Promise<void> {
    // Send message text to the tmux pane
    // Use send-keys with -l (literal) to avoid key interpretation
    execSync(
      `tmux send-keys -t "${this.sessionName}" -l ${JSON.stringify(message)}`
    );
    // Press Enter to submit
    execSync(
      `tmux send-keys -t "${this.sessionName}" Enter`
    );
  }

  captureOutput(): string {
    // Capture the entire visible pane content
    const output = execSync(
      `tmux capture-pane -t "${this.sessionName}" -p -S -1000`,
      { encoding: "utf8" }
    );
    return output;
  }

  captureNewOutput(sinceMarker: string): string {
    const full = this.captureOutput();
    const idx = full.lastIndexOf(sinceMarker);
    if (idx === -1) return full;
    return full.substring(idx + sinceMarker.length);
  }

  async waitForPrompt(timeoutMs = 60000): Promise<string> {
    const start = Date.now();
    let lastOutput = "";
    while (Date.now() - start < timeoutMs) {
      const output = this.captureOutput();
      // Gemini shows a ">" prompt when ready for input
      if (output.trimEnd().endsWith(">") && output !== lastOutput) {
        return output;
      }
      lastOutput = output;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("Timeout waiting for Gemini prompt");
  }

  async sendAndWait(message: string): Promise<string> {
    const beforeOutput = this.captureOutput();
    await this.sendMessage(message);
    // Wait for the next prompt (means Gemini finished responding)
    const afterOutput = await this.waitForPrompt();
    // Extract just the new content
    return afterOutput.substring(beforeOutput.length);
  }

  kill(): void {
    try {
      execSync(`tmux kill-session -t "${this.sessionName}"`);
    } catch {
      // Session may already be dead
    }
  }

  isAlive(): boolean {
    try {
      execSync(
        `tmux has-session -t "${this.sessionName}" 2>/dev/null`
      );
      return true;
    } catch {
      return false;
    }
  }
}
```

### 4.4 The `-i` / `--prompt-interactive` Flag

Gemini CLI has a `--prompt-interactive` flag that executes the initial prompt and then continues in interactive mode. This is useful when spawning in a tmux session because you get the initial task started and the session stays alive for follow-ups:

```bash
gemini -i "Start by analyzing the auth module for vulnerabilities"
# Gemini processes the initial prompt, then waits for more input
```

### 4.5 Gemini CLI Core Package

The `@google/gemini-cli-core` npm package exists but is primarily the core engine used internally by the CLI, not a documented SDK for embedding. It is not recommended for production use as the API is internal and unstable.

---

## 5. Codex CLI: App-Server Protocol

### 5.1 Overview

Codex CLI has the most complete bidirectional protocol of all three agents: the **app-server**. It is a JSON-RPC 2.0 protocol over stdio that supports full bidirectional communication.

### 5.2 Launching the App-Server

```bash
codex app-server
```

This starts a process that reads JSON-RPC requests from stdin and writes responses/notifications to stdout.

### 5.3 Protocol Basics

**Requests** (client to server): Have `method`, `id`, and `params`.
**Responses** (server to client): Have `id` and `result` (or `error`).
**Notifications** (server to client): Have `method` and `params` but no `id`.

**Important**: Unlike standard JSON-RPC, Codex omits the `"jsonrpc":"2.0"` header field.

### 5.4 Initialization Handshake

```typescript
// Step 1: Send initialize request
send({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: {
      name: "agent-monitor",
      title: "Agent Monitor",
      version: "1.0.0"
    },
    capabilities: { experimentalApi: true }
  }
});

// Step 2: Send initialized notification
send({ method: "initialized", params: {} });
```

### 5.5 Thread and Turn Management

#### Start a Thread
```json
{
  "method": "thread/start",
  "id": 10,
  "params": {
    "model": "gpt-5.1-codex",
    "cwd": "/path/to/project",
    "approvalPolicy": "never",
    "sandbox": "workspaceWrite"
  }
}
```

#### Send a Turn (Message to Running Agent)
```json
{
  "method": "turn/start",
  "id": 30,
  "params": {
    "threadId": "thr_123",
    "input": [
      { "type": "text", "text": "Now fix the failing tests" }
    ]
  }
}
```

#### Steer a Running Turn (Inject Message Mid-Turn)
```json
{
  "method": "turn/steer",
  "id": 31,
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_456",
    "input": [
      { "type": "text", "text": "Actually, focus on the auth tests first" }
    ]
  }
}
```

#### Interrupt a Running Turn
```json
{
  "method": "turn/interrupt",
  "id": 32,
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_456"
  }
}
```

### 5.6 Event Notifications (Server to Client)

Turn events:
- `turn/started` -- Turn begins
- `turn/completed` -- Turn finished (completed, interrupted, or failed)
- `turn/diff/updated` -- Aggregated unified diff of changes
- `turn/plan/updated` -- Agent plan with step status

Item events:
- `item/started` -- Work unit begins
- `item/completed` -- Work unit finishes
- `item/agentMessage/delta` -- Streaming text append
- `item/plan/delta` -- Streaming plan text
- `item/reasoning/summaryTextDelta` -- Reasoning summaries
- `item/commandExecution/outputDelta` -- Command stdout/stderr
- `item/fileChange/outputDelta` -- File change patches

Item types: `userMessage`, `agentMessage`, `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `enteredReviewMode`, `exitedReviewMode`.

### 5.7 Approval Flow

When Codex needs approval for a command or file change:

1. Server sends `item/commandExecution/requestApproval` with `parsedCmd` details
2. Client responds with `{ "decision": "accept" }` or `{ "decision": "decline" }`
3. Server continues or cancels the operation

### 5.8 Complete Node.js Implementation

```typescript
import { spawn, ChildProcess } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";

class CodexAppServerClient extends EventEmitter {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }>();

  constructor() {
    super();
    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.rl = readline.createInterface({
      input: this.proc.stdout!
    });
    this.rl.on("line", (line) => {
      this.handleMessage(JSON.parse(line));
    });
  }

  private send(message: unknown): void {
    this.proc.stdin!.write(JSON.stringify(message) + "\n");
  }

  private request(
    method: string,
    params: unknown
  ): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ method, id, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private handleMessage(msg: any): void {
    // Response to our request
    if (
      msg.id !== undefined &&
      this.pendingRequests.has(msg.id)
    ) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(msg.error);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server notification
    if (msg.method) {
      this.emit(msg.method, msg.params);
      this.emit("notification", msg);
    }
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "agent-monitor",
        title: "Agent Monitor",
        version: "1.0.0"
      },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  async startThread(
    model: string,
    cwd: string
  ): Promise<{ thread: { id: string } }> {
    return this.request("thread/start", {
      model,
      cwd,
      approvalPolicy: "never",
      sandbox: "workspaceWrite"
    });
  }

  async sendTurn(
    threadId: string,
    text: string
  ): Promise<any> {
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }]
    });
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    text: string
  ): Promise<any> {
    return this.request("turn/steer", {
      threadId,
      turnId,
      input: [{ type: "text", text }]
    });
  }

  async interruptTurn(
    threadId: string,
    turnId: string
  ): Promise<any> {
    return this.request("turn/interrupt", {
      threadId,
      turnId
    });
  }

  async resumeThread(threadId: string): Promise<any> {
    return this.request("thread/resume", { threadId });
  }

  async listThreads(): Promise<any> {
    return this.request("thread/list", { limit: 50 });
  }

  destroy(): void {
    this.proc.kill();
  }
}

// Usage:
const client = new CodexAppServerClient();
await client.initialize();

const { thread } = await client.startThread(
  "gpt-5.1-codex",
  "/project"
);

// Listen for events
client.on("item/agentMessage/delta", (params) => {
  process.stdout.write(params.text);  // Stream text to UI
});

client.on("turn/completed", (params) => {
  console.log("Turn done:", params.status);
});

// Send initial task
await client.sendTurn(
  thread.id,
  "Analyze the auth module for security issues"
);

// Later: send follow-up to the same thread
await client.sendTurn(
  thread.id,
  "Now fix the SQL injection vulnerability you found"
);
```

### 5.9 Codex exec Mode (Simpler, Less Interactive)

For simpler non-interactive use, `codex exec` supports `--json` for JSONL streaming:

```bash
codex exec --json "Analyze codebase" 2>/dev/null
```

Event types: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.completed`, `error`.

Session resume:
```bash
codex exec resume --last "Fix the issues you found"
codex exec resume <SESSION_ID> "Continue the analysis"
```

**exec mode does NOT support sending follow-up messages to a running turn**. It is strictly fire-and-forget per invocation. For bidirectional communication, use `codex app-server`.

### 5.10 Schema Generation

Generate TypeScript types from the protocol:
```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

---

## 6. node-pty + xterm.js: Web Terminal Bridge

This section covers creating a web-based terminal that connects to CLI agent processes, enabling manual interaction via a browser.

### 6.1 Architecture

```
Browser (xterm.js) <--WebSocket--> Node.js Server (node-pty) <--PTY--> Process (tmux/bash/agent)
```

### 6.2 Server Implementation

```typescript
// server.ts
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import * as pty from "node-pty";
import os from "node:os";

const server = http.createServer();
const io = new SocketIOServer(server, {
  cors: { origin: "*" }
});

// Map of session ID to PTY process
const sessions = new Map<string, pty.IPty>();

io.on("connection", (socket) => {
  const sessionId = socket.handshake.query.sessionId as string;

  if (!sessionId) {
    socket.disconnect();
    return;
  }

  let ptyProcess: pty.IPty;

  if (sessions.has(sessionId)) {
    // Reattach to existing session
    ptyProcess = sessions.get(sessionId)!;
  } else {
    // Spawn a new shell
    ptyProcess = pty.spawn(
      os.platform() === "win32" ? "powershell.exe" : "bash",
      [],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.env.HOME,
        env: process.env as Record<string, string>
      }
    );
    sessions.set(sessionId, ptyProcess);
  }

  // Forward PTY output to browser
  ptyProcess.onData((data: string) => {
    socket.emit("terminal:output", data);
  });

  // Forward browser input to PTY
  socket.on("terminal:input", (data: string) => {
    ptyProcess.write(data);
  });

  // Handle terminal resize
  socket.on("terminal:resize", (size: {
    cols: number;
    rows: number
  }) => {
    ptyProcess.resize(size.cols, size.rows);
  });

  socket.on("disconnect", () => {
    // Don't kill the PTY -- allow reattach
  });
});

server.listen(8080, () => {
  console.log("Terminal server on port 8080");
});
```

### 6.3 Attaching to tmux Sessions via node-pty

To attach a web terminal to an EXISTING tmux session (e.g., one running a Gemini agent):

```typescript
function attachToTmuxSession(
  tmuxSessionName: string
): pty.IPty {
  // Spawn a PTY that runs `tmux attach`
  const ptyProcess = pty.spawn(
    "tmux",
    ["attach-session", "-t", tmuxSessionName],
    {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>
    }
  );
  return ptyProcess;
}

// Create a new tmux session for an agent
function createAgentTmuxSession(
  agentName: string,
  command: string,
  args: string[],
  cwd: string
): string {
  const sessionName = `agent-${agentName}-${Date.now()}`;
  const fullCommand = [command, ...args].join(" ");

  // Create detached tmux session with the agent command
  const { execFileSync } = require("child_process");
  execFileSync("tmux", [
    "new-session", "-d",
    "-s", sessionName,
    "-x", "200",
    "-y", "50",
    "-c", cwd,
    fullCommand
  ]);
  return sessionName;
}
```

### 6.4 Client Implementation

```typescript
// client.ts (browser)
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { io } from "socket.io-client";

function createTerminal(
  containerId: string,
  sessionId: string
) {
  const socket = io("ws://localhost:8080", {
    query: { sessionId }
  });

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 14,
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc"
    }
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  const container = document.getElementById(containerId)!;
  terminal.open(container);
  fitAddon.fit();

  // Server to terminal
  socket.on("terminal:output", (data: string) => {
    terminal.write(data);
  });

  // Terminal to server
  terminal.onData((data) => {
    socket.emit("terminal:input", data);
  });

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    socket.emit("terminal:resize", {
      cols: terminal.cols,
      rows: terminal.rows
    });
  });
  resizeObserver.observe(container);

  return { terminal, socket };
}
```

### 6.5 Package Versions (as of Feb 2026)

```json
{
  "dependencies": {
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "node-pty": "^1.1.0",
    "socket.io": "^4.8.0",
    "socket.io-client": "^4.8.0"
  }
}
```

**Note**: xterm.js was renamed to `@xterm/xterm` (scoped package) starting in v5.4.0. The old `xterm` package is deprecated.

---

## 7. tmux as Process Isolation Layer

### 7.1 Why tmux?

tmux provides:
- **Process isolation**: Agent runs in its own session, survives server restarts
- **Attach/detach**: Multiple web clients can attach/detach without interrupting the agent
- **Output capture**: `capture-pane` provides output without needing to intercept stdout
- **Input injection**: `send-keys` injects text/commands without needing stdin access
- **Named sessions**: Easy to manage multiple agent sessions

### 7.2 node-tmux Package

```bash
npm install node-tmux
```

```typescript
import { tmux } from "node-tmux";

const tm = await tmux();

// Create a session
await tm.newSession("agent-claude-1", "claude --model opus");

// Send input (with Enter key)
await tm.writeInput("agent-claude-1", "Analyze the auth module", true);

// Check if session exists
const exists = await tm.hasSession("agent-claude-1");

// List all sessions
const sessions = await tm.listSessions();

// Kill session
await tm.killSession("agent-claude-1");
```

**Limitation**: node-tmux does NOT have a `captureOutput()` method. You need to call tmux directly for output capture.

### 7.3 Direct tmux Commands (More Control)

```typescript
import { execFileSync } from "child_process";

class TmuxManager {
  // Create a named session running a specific command
  createSession(
    name: string,
    command: string,
    cwd: string
  ): void {
    execFileSync("tmux", [
      "new-session", "-d",
      "-s", name,
      "-x", "200",
      "-y", "50",
      "-c", cwd,
      command
    ]);
  }

  // Send text input to a session (literal mode)
  sendInput(name: string, text: string): void {
    execFileSync("tmux", [
      "send-keys", "-t", name, "-l", text
    ]);
  }

  // Press Enter in a session
  pressEnter(name: string): void {
    execFileSync("tmux", [
      "send-keys", "-t", name, "Enter"
    ]);
  }

  // Send text and press Enter
  sendCommand(name: string, text: string): void {
    this.sendInput(name, text);
    this.pressEnter(name);
  }

  // Capture current pane content
  capturePane(
    name: string,
    historyLines = 1000
  ): string {
    return execFileSync("tmux", [
      "capture-pane",
      "-t", name,
      "-p",
      "-S", `-${historyLines}`
    ], { encoding: "utf8" });
  }

  // Check if session exists
  hasSession(name: string): boolean {
    try {
      execFileSync("tmux", [
        "has-session", "-t", name
      ], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  // List all sessions
  listSessions(): string[] {
    try {
      const output = execFileSync("tmux", [
        "list-sessions",
        "-F", "#{session_name}"
      ], { encoding: "utf8" });
      return output.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  // Kill a session
  killSession(name: string): void {
    execFileSync("tmux", [
      "kill-session", "-t", name
    ]);
  }

  // Resize a session (important for output formatting)
  resizeSession(
    name: string,
    cols: number,
    rows: number
  ): void {
    execFileSync("tmux", [
      "resize-window",
      "-t", name,
      "-x", String(cols),
      "-y", String(rows)
    ]);
  }
}
```

### 7.4 tmux Control Mode (`-CC`)

tmux control mode is a machine-friendly protocol where tmux sends event notifications and accepts commands through stdin/stdout:

```bash
tmux -CC attach-session -t "agent-session"
```

In control mode:
- tmux outputs events as text lines (e.g., `%output`, `%window-changed`, `%session-changed`)
- You send tmux commands via stdin
- The terminal is not rendered -- all I/O is structured text

This could be useful for building a custom tmux client in Node.js without needing node-pty, but it is more complex to implement and is primarily designed for terminal emulator integration (e.g., iTerm2 uses it).

### 7.5 Session Lifecycle for Agent Monitor

```typescript
class AgentSessionManager {
  private tmux = new TmuxManager();
  private sessions = new Map<string, {
    name: string;
    agent: string;
    status: string;
  }>();

  createClaudeSession(
    taskId: string,
    cwd: string
  ): string {
    const name = `claude-${taskId}`;
    this.tmux.createSession(name, "claude", cwd);
    this.sessions.set(taskId, {
      name,
      agent: "claude",
      status: "running"
    });
    return name;
  }

  createGeminiSession(
    taskId: string,
    cwd: string,
    initialPrompt?: string
  ): string {
    const name = `gemini-${taskId}`;
    const cmd = initialPrompt
      ? `gemini -i "${initialPrompt.replace(/"/g, '\\"')}"`
      : "gemini";
    this.tmux.createSession(name, cmd, cwd);
    this.sessions.set(taskId, {
      name,
      agent: "gemini",
      status: "running"
    });
    return name;
  }

  createCodexSession(
    taskId: string,
    cwd: string
  ): string {
    const name = `codex-${taskId}`;
    this.tmux.createSession(name, "codex", cwd);
    this.sessions.set(taskId, {
      name,
      agent: "codex",
      status: "running"
    });
    return name;
  }

  sendMessage(taskId: string, message: string): void {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`Session ${taskId} not found`);
    this.tmux.sendCommand(session.name, message);
  }

  getOutput(taskId: string): string {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`Session ${taskId} not found`);
    return this.tmux.capturePane(session.name);
  }

  destroySession(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (session) {
      this.tmux.killSession(session.name);
      this.sessions.delete(taskId);
    }
  }
}
```

---

## 8. Existing Orchestration Implementations

### 8.1 Agentboard

**Repository**: https://github.com/gbasin/agentboard
**Tech Stack**: Bun + React + xterm.js + tmux CLI

Agentboard is the closest existing implementation to what Agent Monitor needs. Key architecture:

- **Session Discovery**: Polls local tmux windows (and optionally remote hosts via SSH)
- **Status Inference**: Reads pane content and Claude/Codex JSONL logs to determine agent state ("working", "waiting for input", "asking for permission")
- **Live Terminal Streaming**: WebSocket connections deliver real-time I/O via xterm.js
- **Terminal Modes**: `pty` (grouped session, default) or `pipe-pane` (PTY-less, systemd/Docker compatible)
- **Agent-Specific**: Built-in log parsing for Claude and Codex agents
- **Mobile**: iOS Safari support with virtual d-pad controls
- **SQLite**: Session history persistence with configurable retention

### 8.2 Claude-Flow

**Repository**: https://github.com/ruvnet/claude-flow
**Architecture**: Multi-agent orchestration via MCP

Claude-Flow orchestrates multiple Claude instances using stream-json chaining:
- Detects task dependencies from workflow definitions
- Captures stdout streams from dependency tasks
- Pipes them to stdin of dependent tasks
- Adds `--input-format stream-json` automatically
- Maintains stream connections

Primarily focused on agent-to-agent communication rather than human-to-agent interaction.

### 8.3 claude-code-by-agents

**Repository**: https://github.com/baryhuang/claude-code-by-agents
**Architecture**: Desktop app + API for multi-agent Claude Code orchestration

- Coordinates local and remote agents through @mentions
- Orchestrator routes tasks to specialized agents
- HTTP endpoints for remote agent communication
- Not tmux-based; uses direct subprocess management

### 8.4 WebTMUX

**Repository**: https://github.com/nonoxz/webtmux
**Tech Stack**: Express + Socket.io + xterm.js

A straightforward web-based tmux session viewer:
- Connect to tmux sessions through a browser
- Uses Express for HTTP, Socket.io for WebSocket, xterm.js for rendering
- Good reference implementation for the tmux-to-web bridge pattern

### 8.5 webmux (nooesc)

**Repository**: https://github.com/nooesc/webmux
**Tech Stack**: Rust backend + Vue.js frontend

High-performance web-based tmux session viewer:
- All communication via WebSocket (no REST endpoints)
- PWA support with mobile optimization
- Rust backend for low-latency terminal streaming

---

## 9. Comparison Table

### 9.1 Agent Communication Capabilities

| Feature | Claude Code (SDK) | Codex (app-server) | Gemini CLI |
|---------|------------------|--------------------|-----------|
| Native bidirectional | YES | YES | NO |
| Send follow-up to running agent | YES (yield to generator / send()) | YES (turn/start, turn/steer) | NO (tmux workaround) |
| Interrupt running task | YES (interrupt()) | YES (turn/interrupt) | NO (Ctrl+C via tmux) |
| Stream output tokens | YES (includePartialMessages) | YES (item/agentMessage/delta) | Partial (stream-json output only) |
| Tool approval callback | YES (canUseTool) | YES (requestApproval protocol) | NO |
| Session resume | YES (resume option, session ID) | YES (thread/resume) | NO |
| Multi-turn conversations | YES (async generator / V2 sessions) | YES (multiple turns per thread) | YES (tmux interactive only) |
| Structured output | YES (json-schema) | YES (output-schema) | YES (--output-format json) |
| Protocol | NDJSON over subprocess stdio | JSON-RPC 2.0 over stdio | None (CLI args + stdout) |
| SDK language | TypeScript, Python | TypeScript, Go, Python, Swift, Kotlin | None (CLI only) |

### 9.2 Approach Comparison for Web UI Integration

| Approach | Pros | Cons | Best For |
|----------|------|------|----------|
| **Claude Agent SDK** | Full control, typed API, hooks, interrupts | Claude only, Node.js dependency | Claude programmatic control |
| **Codex app-server** | Full bidirectional JSON-RPC, approval flow | Codex only, more complex protocol | Codex programmatic control |
| **tmux + send-keys** | Universal, works with any CLI agent | Polling-based, no structured output, parsing fragile | Gemini, fallback for all agents |
| **tmux + node-pty + xterm.js** | Full terminal in browser, manual interaction | Complex setup, requires tmux on server | Manual agent interaction via web |
| **Direct node-pty** | Simple PTY management, no tmux needed | No detach/reattach, no multi-client | Single-user web terminal |

### 9.3 Recommended Stack Per Agent

| Agent | Programmatic Control | Web Terminal (Manual) |
|-------|---------------------|-----------------------|
| **Claude Code** | Agent SDK (TypeScript V2) | tmux session + xterm.js attach |
| **Codex CLI** | `codex app-server` JSON-RPC client | tmux session + xterm.js attach |
| **Gemini CLI** | tmux + send-keys/capture-pane | tmux session + xterm.js attach |

---

## 10. Architecture Recommendations

### 10.1 Recommended Architecture for Agent Monitor

```
                    +------------------+
                    |   Web Browser    |
                    |  (React/Next.js) |
                    +--------+---------+
                             |
                    WebSocket + REST API
                             |
                    +--------+---------+
                    |   Node.js Server |
                    |  (Agent Monitor) |
                    +--------+---------+
                             |
            +----------------+----------------+
            |                |                |
    +-------+------+  +-----+------+  +------+-------+
    | Claude Agent  |  | Codex App  |  | Gemini tmux  |
    | SDK Client    |  | Server     |  | Session Mgr  |
    | (TypeScript)  |  | Client     |  |              |
    +-------+------+  +-----+------+  +------+-------+
            |                |                |
    Claude Code CLI   Codex app-server   tmux session
    (subprocess)      (subprocess)       running gemini
```

### 10.2 Unified Agent Interface

```typescript
interface AgentController {
  // Lifecycle
  start(config: AgentConfig): Promise<string>;  // returns session ID
  stop(sessionId: string): Promise<void>;
  isAlive(sessionId: string): boolean;

  // Bidirectional communication
  sendMessage(sessionId: string, message: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;

  // Output streaming
  onOutput(
    sessionId: string,
    callback: (event: AgentEvent) => void
  ): void;

  // Web terminal access
  getTmuxSessionName(sessionId: string): string | null;
}

interface AgentEvent {
  type:
    | "text"
    | "tool_use"
    | "tool_result"
    | "status"
    | "error"
    | "completion";
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

interface AgentConfig {
  agent: "claude" | "codex" | "gemini";
  cwd: string;
  model?: string;
  initialPrompt?: string;
  allowedTools?: string[];
  autoApprove?: boolean;
}
```

### 10.3 Dual-Mode Architecture (Recommended)

For each agent session, maintain BOTH:
1. **Programmatic channel** (SDK/app-server/tmux-polling) for structured data
2. **tmux session** for web terminal attachment

This allows:
- Structured events and data flow through the programmatic channel
- Users can "drop into" the terminal at any time via xterm.js
- The agent process survives web disconnections (tmux keeps it alive)
- Multiple users can observe the same session

```
                                    Web Browser
                                   /           \
                      WebSocket (events)    WebSocket (terminal)
                         /                        \
                   API Server                Terminal Server
                   /    |    \                    |
           Claude SDK  Codex   Gemini       node-pty attach
           (subprocess) app-srv tmux-poll        |
                |       |       |          tmux attach -t session
                |       |       |                |
           Claude CLI  Codex   Gemini     <--- tmux session
           (in tmux)   (in tmux) (in tmux)     (shared)
```

### 10.4 Implementation Priority

**Phase 1: Foundation**
- Implement `TmuxManager` class for session lifecycle management
- Implement web terminal attachment (node-pty + xterm.js + WebSocket)
- All three agents run in tmux sessions with tmux-based bidirectional communication
- This gives immediate bidirectional support for all agents with a single codebase

**Phase 2: Native Protocols**
- Add Claude Agent SDK integration (V2 `send()`/`stream()`) for richer Claude control
- Add Codex app-server JSON-RPC client for richer Codex control
- Keep tmux sessions running underneath for terminal attachment fallback
- Structured events flow through native protocols; terminal access remains via tmux

**Phase 3: Advanced Features**
- Tool approval forwarding to web UI (Claude `canUseTool`, Codex `requestApproval`)
- Session resume across server restarts
- Multi-user concurrent terminal viewing
- Agent status inference from logs (like Agentboard does)

---

## 11. Sources

### Claude Code
- [Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [TypeScript V2 preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [Streaming vs single mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Stream-JSON chaining (claude-flow wiki)](https://github.com/ruvnet/claude-flow/wiki/Stream-Chaining)
- [GitHub: stream-json input hang issue #3187](https://github.com/anthropics/claude-code/issues/3187)
- [Claude Agent SDK TypeScript (GitHub)](https://github.com/anthropics/claude-agent-sdk-typescript)

### Codex CLI
- [Codex app-server documentation](https://developers.openai.com/codex/app-server/)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference/)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- [Unlocking the Codex harness: app-server](https://openai.com/index/unlocking-the-codex-harness/)
- [Codex app-server README (GitHub)](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

### Gemini CLI
- [Gemini CLI headless mode (official)](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html)
- [Gemini CLI headless mode (community docs)](https://geminicli.com/docs/cli/headless/)
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)
- [Add stream-json input format request (issue #8203)](https://github.com/google-gemini/gemini-cli/issues/8203)
- [New interactivity in Gemini CLI (Google blog)](https://developers.googleblog.com/en/say-hello-to-a-new-level-of-interactivity-in-gemini-cli/)

### Web Terminal
- [xterm.js](https://xtermjs.org/)
- [xterm.js GitHub](https://github.com/xtermjs/xterm.js)
- [Web terminal with xterm.js, node-pty, and WebSockets](https://ashishpoudel.substack.com/p/web-terminal-with-xtermjs-node-pty)
- [Creating browser-based interactive terminal](https://www.eddymens.com/blog/creating-a-browser-based-interactive-terminal-using-xtermjs-and-nodejs)
- [node-pty + Socket.io for multiple users](https://medium.com/@deysouvik700/efficient-and-scalable-usage-of-node-js-pty-with-socket-io-for-multiple-users-402851075c4a)
- [tmux attach in xterm issue #1345](https://github.com/xtermjs/xterm.js/issues/1345)

### tmux Management
- [node-tmux (npm)](https://www.npmjs.com/package/node-tmux)
- [node-tmux GitHub](https://github.com/StarlaneStudios/node-tmux)
- [tmux control mode](https://github.com/tmux/tmux/wiki/Control-Mode)

### Agent Orchestration
- [Agentboard -- Web GUI for tmux + AI agents](https://github.com/gbasin/agentboard)
- [claude-flow -- Multi-agent orchestration](https://github.com/ruvnet/claude-flow)
- [claude-code-by-agents](https://github.com/baryhuang/claude-code-by-agents)
- [WebTMUX -- Web browser tmux interaction](https://github.com/nonoxz/webtmux)
- [webmux (nooesc) -- Rust+Vue tmux viewer](https://github.com/nooesc/webmux)

---

## Appendix A: Quick Decision Matrix

**"I want to send a message to a running Claude agent"**
--> Use `@anthropic-ai/claude-agent-sdk` with `AsyncIterable<SDKUserMessage>` (V1) or `session.send()` (V2)

**"I want to send a message to a running Codex agent"**
--> Use `codex app-server` with `turn/start` or `turn/steer` JSON-RPC methods

**"I want to send a message to a running Gemini agent"**
--> Use `tmux send-keys -t "session-name" -l "message"` followed by `tmux send-keys -t "session-name" Enter`

**"I want a user to type directly into a running agent via web browser"**
--> Spawn agent in tmux session, use node-pty to `tmux attach`, bridge to xterm.js via WebSocket

**"I want to approve/deny a tool use from a web UI"**
--> Claude: `canUseTool` callback. Codex: respond to `requestApproval` JSON-RPC event. Gemini: type "y"/"n" via `tmux send-keys`.

**"I want to resume a session after server restart"**
--> Claude: `unstable_v2_resumeSession(sessionId)` or `--resume sessionId`. Codex: `thread/resume`. Gemini: tmux sessions survive server restart if tmux server is still running.
