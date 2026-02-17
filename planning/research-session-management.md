# AI CLI Tools: Session Management Research

> Research compiled 2026-02-17 for the Agent Monitor project.
> Goal: Understand how to spawn AI agents (Claude Code, Gemini CLI, Codex CLI) and resume previous sessions programmatically.

---

## Table of Contents

1. [Claude Code CLI](#1-claude-code-cli)
2. [Gemini CLI](#2-gemini-cli)
3. [Codex CLI](#3-codex-cli)
4. [Other AI CLI Tools](#4-other-ai-cli-tools)
5. [Terminal Session Management Patterns](#5-terminal-session-management-patterns)
6. [Multi-Agent Orchestration Frameworks](#6-multi-agent-orchestration-frameworks)
7. [Common Patterns Across Tools](#7-common-patterns-across-tools)
8. [Recommended Architecture for Agent Monitor](#8-recommended-architecture-for-agent-monitor)

---

## 1. Claude Code CLI

### Session Management Flags

| Flag                       | Description                                                      | Example                                      |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| `--continue`, `-c`         | Load most recent conversation in current directory               | `claude -c`                                  |
| `--resume`, `-r`           | Resume session by ID/name, or show interactive picker            | `claude -r "auth-refactor"`                  |
| `--session-id`             | Use a specific session ID (must be valid UUID)                   | `claude --session-id "550e8400-..."`         |
| `--fork-session`           | When resuming, create new session ID instead of reusing original | `claude --resume abc123 --fork-session`      |
| `--from-pr`                | Resume sessions linked to a specific GitHub PR                   | `claude --from-pr 123`                       |
| `--no-session-persistence` | Disable session persistence (print mode only)                    | `claude -p --no-session-persistence "query"` |
| `--print`, `-p`            | Non-interactive mode (SDK mode)                                  | `claude -p "query"`                          |
| `--output-format`          | Output format: `text`, `json`, `stream-json`                     | `claude -p --output-format json "query"`     |

### Session Storage on Disk

```
~/.claude/
+-- history.jsonl                    # Session metadata index (all sessions)
+-- projects/                        # Conversation transcripts by project
|   +-- -home-user-project-a/        # Path-encoded project directory
|   |   +-- <session-id-1>.jsonl     # Full conversation transcript
|   |   +-- <session-id-2>.jsonl
|   +-- -home-user-project-b/
|       +-- <session-id-3>.jsonl
+-- session-env/                     # Session environment data
+-- todos/                           # Todo lists per session
```

- **Project directories** are encoded from the absolute path of the working directory (slashes replaced with dashes)
- **Session files** are JSONL (JSON Lines) format containing full conversation history, tool calls, and responses
- **Session IDs** are UUIDs
- **Sessions can be named** for easy recall: `claude --resume "auth-refactor"`

### Programmatic Usage (CLI Print Mode)

```bash
# Start a new session, capture session ID from JSON output
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')

# Resume that specific session
claude -p "Continue the review" --resume "$session_id"

# Continue most recent session
claude -p "Check for type errors" --continue

# Stream JSON events (includes session_id in every message)
claude -p "Explain recursion" --output-format stream-json --verbose
```

**JSON output structure** (when using `--output-format json`):

```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "result": "...",
  "duration_ms": 12345,
  "total_cost_usd": 0.05,
  "num_turns": 3,
  "usage": { "input_tokens": 1000, "output_tokens": 500 }
}
```

### TypeScript Agent SDK (V1)

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// Start a new session
let sessionId: string | undefined;
const response = query({
  prompt: 'Help me build a web application',
  options: { model: 'claude-opus-4-6' },
});

for await (const message of response) {
  if (message.type === 'system' && message.subtype === 'init') {
    sessionId = message.session_id;
  }
  // Every message has session_id field
}

// Resume a session
const resumed = query({
  prompt: 'Continue where we left off',
  options: {
    resume: sessionId, // Pass session ID
    forkSession: false, // true = create branch, false = continue original
    model: 'claude-opus-4-6',
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
  },
});

// Continue most recent session
const continued = query({
  prompt: 'Keep going',
  options: { continue: true },
});
```

**Key SDK Options for session management:**

| Option            | Type              | Description                                           |
| ----------------- | ----------------- | ----------------------------------------------------- |
| `resume`          | `string`          | Session ID to resume                                  |
| `forkSession`     | `boolean`         | Fork to new session ID instead of continuing original |
| `continue`        | `boolean`         | Continue most recent conversation                     |
| `cwd`             | `string`          | Working directory (affects which sessions are found)  |
| `abortController` | `AbortController` | Cancel operations                                     |
| `maxTurns`        | `number`          | Limit agentic turns                                   |
| `maxBudgetUsd`    | `number`          | Budget cap                                            |

**SDK Message types with session_id:**

- `SDKSystemMessage` (type: "system", subtype: "init") - Contains initial session_id
- `SDKAssistantMessage` - Contains session_id
- `SDKUserMessage` - Contains session_id
- `SDKResultMessage` - Contains session_id, cost, usage, duration

### TypeScript Agent SDK (V2 Preview)

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';

// Create session
await using session = unstable_v2_createSession({
  model: 'claude-opus-4-6',
});

await session.send('Remember this number: 42');
let sessionId: string | undefined;
for await (const msg of session.stream()) {
  sessionId = msg.session_id;
}
session.close();

// Resume session later
await using resumed = unstable_v2_resumeSession(sessionId!, {
  model: 'claude-opus-4-6',
});
await resumed.send('What number did I ask you to remember?');
for await (const msg of resumed.stream()) {
  // msg.session_id available on every message
}
```

**V2 API surface:**

- `unstable_v2_createSession(options)` - Create new session
- `unstable_v2_resumeSession(sessionId, options)` - Resume by ID
- `unstable_v2_prompt(prompt, options)` - One-shot (no session)
- `session.send(message)` - Send a turn
- `session.stream()` - Get response stream
- `session.close()` - Clean up

### Listing Sessions

There is no documented API or CLI flag to list all sessions programmatically. Available approaches:

1. Parse `~/.claude/history.jsonl` for session metadata
2. Scan `~/.claude/projects/<project-hash>/` for session JSONL files
3. Use `claude --resume` (without ID) to get interactive picker (not automatable)

### Sources

- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Agent SDK Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [TypeScript SDK V1](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [TypeScript SDK V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Session persistence wiki](https://github.com/ruvnet/claude-flow/wiki/session-persistence)
- [Migrate sessions](https://www.vincentschmalbach.com/migrate-claude-code-sessions-to-a-new-computer/)

---

## 2. Gemini CLI

### Session Management Flags

| Flag / Command                  | Description                                      | Example                             |
| ------------------------------- | ------------------------------------------------ | ----------------------------------- |
| `--resume`                      | Resume latest session (no args) or by index/UUID | `gemini --resume`                   |
| `--resume <index>`              | Resume by index number                           | `gemini --resume 1`                 |
| `--resume <UUID>`               | Resume by full session UUID                      | `gemini --resume a1b2c3d4-e5f6-...` |
| `--list-sessions`               | List available sessions with details             | `gemini --list-sessions`            |
| `--delete-session <index/UUID>` | Delete a session                                 | `gemini --delete-session 2`         |
| `/resume`                       | Interactive session browser (inside CLI)         | Type `/resume` at prompt            |
| `/chat save <tag>`              | Save current session with a named tag            | `/chat save auth-refactor`          |
| `/chat resume <tag>`            | Resume a named checkpoint                        | `/chat resume auth-refactor`        |
| `/chat list`                    | List saved checkpoints                           | `/chat list`                        |
| `/chat delete <tag>`            | Delete a checkpoint                              | `/chat delete auth-refactor`        |
| `/chat share file.md`           | Export session to file                           | `/chat share output.json`           |

### Session Storage on Disk

```
~/.gemini/
+-- tmp/
    +-- <project_hash>/           # Hash derived from project root path
        +-- chats/                # Automatic session history
            +-- <session-uuid-1>.json
            +-- <session-uuid-2>.json
            +-- checkpoint-<tag>.json  # Named checkpoints from /chat save
```

- **Project-scoped**: Changing directories switches to that project's session history
- **Automatic saving**: Every session is saved in the background (since v0.20.0+)
- **Format**: JSON files containing complete conversation history, tool executions, and token usage
- **Session IDs**: UUIDs (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)

### Listing Sessions Output

```
$ gemini --list-sessions

Available sessions for this project (3):

 1. Fix bug in auth (2 days ago) [a1b2c3d4]
 2. Refactor database schema (5 hours ago) [e5f67890]
 3. Update documentation (Just now) [abcd1234]
```

### Configuration (settings.json)

```json
{
  "general": {
    "sessionRetention": {
      "enabled": true,
      "maxAge": "30d",
      "maxCount": 50,
      "minRetention": "1d"
    }
  },
  "model": {
    "maxSessionTurns": 100
  }
}
```

### What Gets Saved

- Complete conversation history (prompts and responses)
- Tool execution details (inputs and outputs)
- Token usage statistics
- Assistant reasoning summaries (when available)

### Programmatic Access Limitations

- `--list-sessions` provides text output (parseable but not JSON)
- No documented SDK or programmatic API for session management
- Non-interactive mode: when `maxSessionTurns` is reached, exits with error
- No `--output-format json` equivalent for structured output

### Sources

- [Gemini CLI Session Management](https://geminicli.com/docs/cli/session-management/)
- [Session Management docs on GitHub](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)
- [Google Developers Blog](https://developers.googleblog.com/pick-up-exactly-where-you-left-off-with-session-management-in-gemini-cli/)
- [CLI Commands](https://geminicli.com/docs/cli/commands/)
- [Session ID feature request](https://github.com/google-gemini/gemini-cli/issues/8944)

---

## 3. Codex CLI

### Session Management Commands

**Interactive mode:**

| Command                     | Description                                    | Example                     |
| --------------------------- | ---------------------------------------------- | --------------------------- |
| `codex resume`              | Interactive session picker (current directory) | `codex resume`              |
| `codex resume --last`       | Resume most recent session                     | `codex resume --last`       |
| `codex resume --all`        | Show sessions from all directories             | `codex resume --all`        |
| `codex resume <SESSION_ID>` | Resume specific session by UUID                | `codex resume 7f9f9a2e-...` |
| `/resume`                   | In-session picker (slash command)              | Type `/resume` at prompt    |
| `/status`                   | Show current session info including ID         | `/status`                   |

**Non-interactive (exec) mode:**

| Command                             | Description                           | Example                                  |
| ----------------------------------- | ------------------------------------- | ---------------------------------------- |
| `codex exec resume --last "prompt"` | Resume latest + follow-up instruction | `codex exec resume --last "fix the bug"` |
| `codex exec resume <ID> "prompt"`   | Resume specific session + instruction | `codex exec resume abc123 "add tests"`   |
| `codex exec resume --last --all`    | Resume latest from any directory      | `codex exec resume --last --all`         |
| `--ephemeral`                       | Don't persist session to disk         | `codex exec --ephemeral "quick check"`   |
| `--json`                            | JSONL streaming output                | `codex exec --json "task"`               |

### Session Storage on Disk

```
~/.codex/
+-- sessions/
    +-- YYYY/
        +-- MM/
            +-- DD/
                +-- rollout-YYYY-MM-DDThh-mm-ss-<hash>.jsonl
```

- **Date-organized**: Sessions sorted by date in YYYY/MM/DD hierarchy
- **Format**: JSONL (JSON Lines) with metadata header + event stream
- **Session IDs**: UUIDs (e.g., `7f9f9a2e-1b3c-4c7a-9b0e-...`)

### JSONL Format Structure

```
Line 1: SessionMeta (metadata header with session ID, model, timestamp)
Line 2+: Event messages (user turns, agent responses, tool calls, token counts)
```

**Event types in `--json` output:**

- `thread.started` - Session begins (contains `thread_id`)
- `turn.started` - New turn begins
- `turn.completed` - Turn finishes
- `turn.failed` - Turn error
- `item.*` - Individual items (messages, tool calls)
- `error` - Error events

### Session State Preservation

Resumed runs maintain:

- Original transcript
- Plan history
- Approvals/permissions
- Prior context

Can override working directory with `--cd` or add extra roots with `--add-dir`.

### Experimental Resume Config

```bash
codex -c experimental_resume="~/.codex/sessions/2025/01/22/rollout-2025-01-22T10-30-00-abc123.jsonl"
```

### Sources

- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- [Non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- [Resume discussion](https://github.com/openai/codex/discussions/1076)
- [Slash commands](https://developers.openai.com/codex/cli/slash-commands/)

---

## 4. Other AI CLI Tools

### Aider

- **Session files**: `.aider.chat.history.md` (markdown) and `.aider.input.history` (input log)
- **Resume flag**: `--restore-chat-history` loads and summarizes prior history
- **Mechanism**: When history exceeds token limits, older messages are summarized recursively while recent messages are kept verbatim
- **No session IDs**: Aider doesn't have formal session management. Each launch is a fresh session, with optional history restoration via summarization
- **Storage**: In the project directory (not global)

Sources: [Aider FAQ](https://aider.chat/docs/faq.html), [Issue #166](https://github.com/paul-gauthier/aider/issues/166)

### Coding Agent Session Search (CASS)

A unified TUI/CLI tool that indexes sessions across 11+ AI coding agents. Useful reference for session storage locations:

| Provider       | Storage Path                            | Format           |
| -------------- | --------------------------------------- | ---------------- |
| Claude Code    | `~/.claude/projects`                    | Session JSONL    |
| Codex          | `~/.codex/sessions`                     | Rollout JSONL    |
| Gemini CLI     | `~/.gemini/tmp`                         | Chat JSON        |
| Cline          | VS Code global storage                  | Task directories |
| Aider          | Project directory                       | Markdown files   |
| OpenCode       | `.opencode` directories                 | SQLite           |
| Amp            | `~/.local/share/amp`                    | Various          |
| Clawdbot       | `~/.clawdbot/sessions`                  | Session JSONL    |
| Vibe (Mistral) | `~/.vibe/logs/session/*/messages.jsonl` | Session JSONL    |

Source: [coding_agent_session_search](https://github.com/Dicklesworthstone/coding_agent_session_search)

---

## 5. Terminal Session Management Patterns

### node-tmux (Node.js Library)

```bash
npm install --save node-tmux
```

```typescript
import { tmux } from 'node-tmux';

const tm = await tmux();

// Create session
await tm.newSession('agent-1', 'claude -p "task"');

// List sessions
const sessions = await tm.listSessions(); // Returns string[]

// Check existence
const exists = await tm.hasSession('agent-1'); // Returns boolean

// Kill session
await tm.killSession('agent-1');
```

Source: [node-tmux on npm](https://www.npmjs.com/package/node-tmux)

### tmux-mcp-server

An MCP server that enables AI assistants to interact with tmux for terminal multiplexing and session management.

Source: [@audibleblink/tmux-mcp-server](https://www.npmjs.com/package/@audibleblink/tmux-mcp-server)

### Named Tmux Manager (NTM)

Coordinates multiple AI coding agents (Claude, Codex, Gemini) across tmux panes:

- All agents live in a single tmux session with tiled panes
- Each pane is labeled for identification
- Supports broadcast prompts to all agents
- Persistent sessions that survive detach/reattach

Source: [NTM on GitHub](https://github.com/Dicklesworthstone/ntm)

### Key tmux Commands (Programmatic)

```bash
# Create named session
tmux new-session -d -s "agent-claude" "claude -p 'task'"

# List sessions
tmux list-sessions -F "#{session_name}:#{session_id}"

# Send keys to session
tmux send-keys -t "agent-claude" "follow-up prompt" Enter

# Capture pane output
tmux capture-pane -t "agent-claude" -p

# Kill session
tmux kill-session -t "agent-claude"

# Check if session exists
tmux has-session -t "agent-claude" 2>/dev/null && echo "exists"
```

---

## 6. Multi-Agent Orchestration Frameworks

### CLI Agent Orchestrator (CAO) - AWS

- **Architecture**: Supervisor agent coordinates specialized worker agents
- **Session isolation**: Each agent in isolated tmux sessions
- **Communication**: Via MCP (Model Context Protocol) servers
- **Orchestration patterns**:
  - _Handoff_: Synchronous task transfer with wait-for-completion
  - _Assign_: Asynchronous task spawning for parallel execution
- **Hierarchical**: Supervisor maintains project context while agents focus on domains

Source: [AWS Open Source Blog](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)

### AI Agent Orchestrator (hoangsonww)

- Coordinates Claude, Codex, Gemini CLI, Copilot CLI
- Accessible via REPL or Vue UI dashboard
- Intelligent task delegation across agents

Source: [AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator)

### LangGraph

- State-based memory with checkpointing and persistence
- Every node receives/mutates a serializable state object
- Checkpointing enables deterministic replay
- Graph structures with conditional edges

### CrewAI

- Role-based memory with RAG
- Shared crew store (local SQLite)
- Per-role context isolation

### AutoGen / Microsoft Agent Framework

- Centralized transcript as short-term memory
- Aggressive pruning at token limits
- Session-based state management
- Graph-based workflows for multi-agent orchestration

### claude-flow

- Session persistence for Claude Code orchestration
- Stores: conversation history, background processes, file context, permissions
- JSON format with background task tracking (PIDs, output positions)

Source: [claude-flow wiki](https://github.com/ruvnet/claude-flow/wiki/session-persistence)

---

## 7. Common Patterns Across Tools

### Session Identification

| Tool        | ID Format         | Named Sessions            |
| ----------- | ----------------- | ------------------------- |
| Claude Code | UUID              | Yes (string names)        |
| Gemini CLI  | UUID              | Yes (tags via /chat save) |
| Codex CLI   | UUID              | No                        |
| Aider       | None (file-based) | No                        |

### Resume Mechanisms

| Tool        | Resume Latest            | Resume by ID      | Non-Interactive Resume               | Fork/Branch      |
| ----------- | ------------------------ | ----------------- | ------------------------------------ | ---------------- |
| Claude Code | `--continue`             | `--resume <id>`   | `--continue -p` / `--resume <id> -p` | `--fork-session` |
| Gemini CLI  | `--resume`               | `--resume <uuid>` | Limited                              | No               |
| Codex CLI   | `resume --last`          | `resume <id>`     | `exec resume --last`                 | No               |
| Aider       | `--restore-chat-history` | No                | No                                   | No               |

### Storage Formats

| Tool        | Format   | Location                                                 |
| ----------- | -------- | -------------------------------------------------------- |
| Claude Code | JSONL    | `~/.claude/projects/<path-hash>/<session-id>.jsonl`      |
| Gemini CLI  | JSON     | `~/.gemini/tmp/<project-hash>/chats/<session-uuid>.json` |
| Codex CLI   | JSONL    | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`           |
| Aider       | Markdown | `.aider.chat.history.md` (project dir)                   |

### Session Lifecycle

All tools follow the same basic lifecycle:

1. **Create**: New session with UUID, store on disk
2. **Execute**: Stream messages, tool calls, responses (saved incrementally)
3. **Close/Suspend**: Session persists on disk
4. **Resume**: Reload conversation history, restore context
5. **Cleanup**: Auto-pruning by age/count (configurable)

### Output Streaming for Automation

| Tool        | JSON Output               | Session ID in Output | Streaming Events              |
| ----------- | ------------------------- | -------------------- | ----------------------------- |
| Claude Code | `--output-format json`    | Yes (every message)  | `--output-format stream-json` |
| Codex CLI   | `--json`                  | Yes (`thread_id`)    | JSONL events                  |
| Gemini CLI  | No structured output flag | No standard output   | No                            |

---

## 8. Recommended Architecture for Agent Monitor

### Core Design Principles

1. **Use SDK where available** (Claude Code TypeScript SDK is the most mature)
2. **Fall back to CLI subprocess + JSON parsing** for tools without SDKs
3. **Maintain a session registry** mapping agent instances to session IDs
4. **Use tmux as process isolation layer** for CLI-only tools

### Architecture Layers

```
+--------------------------------------------------+
|                Agent Monitor UI                   |
+--------------------------------------------------+
|              Session Registry                     |
|  (SQLite/JSON: agent_id, tool, session_id,       |
|   status, cwd, created_at, last_active)          |
+----------+---------------+-----------------------+
| Claude   | Codex         | Gemini                |
| Adapter  | Adapter       | Adapter               |
+----------+---------------+-----------------------+
| SDK      | CLI+JSON      | CLI+tmux              |
| (native) | (subprocess)  | (subprocess)          |
+----------+---------------+-----------------------+
```

### Claude Code Adapter (Recommended: SDK)

```typescript
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

interface AgentSession {
  agentId: string;
  sessionId?: string;
  tool: 'claude' | 'codex' | 'gemini';
  status: 'running' | 'paused' | 'completed' | 'error';
  cwd: string;
}

class ClaudeAdapter {
  async startSession(task: string, cwd: string): Promise<AgentSession> {
    const agent: AgentSession = {
      agentId: crypto.randomUUID(),
      tool: 'claude',
      status: 'running',
      cwd,
    };

    const response = query({
      prompt: task,
      options: {
        model: 'claude-opus-4-6',
        cwd,
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
      },
    });

    for await (const msg of response) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        agent.sessionId = msg.session_id;
      }
      if (msg.type === 'result') {
        agent.status = msg.is_error ? 'error' : 'completed';
      }
      // Emit events to UI...
    }

    return agent;
  }

  async resumeSession(sessionId: string, prompt: string, cwd: string) {
    const response = query({
      prompt,
      options: {
        resume: sessionId,
        cwd,
        model: 'claude-opus-4-6',
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
      },
    });

    for await (const msg of response) {
      // Process messages, emit to UI...
    }
  }

  async forkSession(sessionId: string, prompt: string, cwd: string) {
    const response = query({
      prompt,
      options: {
        resume: sessionId,
        forkSession: true, // Branch without modifying original
        cwd,
        model: 'claude-opus-4-6',
      },
    });
    // New session_id returned in init message
  }
}
```

### Codex Adapter (CLI + JSON parsing)

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

class CodexAdapter {
  private codexPath = '/home/ubuntu/.bun/bin/codex';

  async startSession(task: string, cwd: string): Promise<AgentSession> {
    const agent: AgentSession = {
      agentId: crypto.randomUUID(),
      tool: 'codex',
      status: 'running',
      cwd,
    };

    // Write prompt to file to avoid shell escaping issues
    const promptFile = `/tmp/codex-prompt-${agent.agentId}.txt`;
    await fs.writeFile(promptFile, task);

    // Use execFile (not exec) to avoid shell injection
    const proc = spawn(this.codexPath, ['exec', '--json', '-C', cwd, '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe prompt file content to stdin
    const promptContent = await fs.readFile(promptFile, 'utf-8');
    proc.stdin.write(promptContent);
    proc.stdin.end();

    // Parse JSONL output for session ID
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'thread.started') {
          agent.sessionId = event.thread_id;
        }
        // Emit events to UI...
      }
    });

    return agent;
  }

  async resumeSession(sessionId: string, prompt: string, cwd: string) {
    // Use execFile with array args (no shell injection risk)
    const proc = spawn(this.codexPath, ['exec', 'resume', sessionId, '--json', '-C', cwd, prompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Parse JSONL output...
  }

  async resumeLatest(prompt: string, cwd: string) {
    const proc = spawn(this.codexPath, ['exec', 'resume', '--last', '--json', '-C', cwd, prompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Parse JSONL output...
  }
}
```

### Gemini Adapter (CLI + tmux)

Gemini CLI lacks structured output and a programmatic SDK, so use tmux for session management:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

class GeminiAdapter {
  async startSession(task: string, cwd: string): Promise<AgentSession> {
    const agent: AgentSession = {
      agentId: crypto.randomUUID(),
      tool: 'gemini',
      status: 'running',
      cwd,
    };
    const tmuxSession = `gemini-${agent.agentId.slice(0, 8)}`;

    // Create tmux session running gemini (using execFile for safety)
    await execFileAsync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, 'gemini']);

    // Wait for gemini to initialize, then send the task
    await sleep(2000);
    await execFileAsync('tmux', ['send-keys', '-t', tmuxSession, task, 'Enter']);

    return agent;
  }

  async resumeSession(sessionId: string, cwd: string) {
    const tmuxSession = `gemini-resume-${Date.now()}`;
    await execFileAsync('tmux', [
      'new-session',
      '-d',
      '-s',
      tmuxSession,
      '-c',
      cwd,
      `gemini --resume ${sessionId}`,
    ]);
  }

  async captureOutput(tmuxSession: string): Promise<string> {
    const { stdout } = await execFileAsync('tmux', [
      'capture-pane',
      '-t',
      tmuxSession,
      '-p',
      '-S',
      '-100',
    ]);
    return stdout;
  }

  async listSessions(cwd: string): Promise<string> {
    // Parse gemini --list-sessions output
    const { stdout } = await execFileAsync('gemini', ['--list-sessions'], { cwd });
    return stdout;
  }
}
```

### Session Registry

```sql
-- SQLite schema for session registry
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,           -- Agent Monitor's internal ID
  tool TEXT NOT NULL,             -- 'claude' | 'codex' | 'gemini'
  session_id TEXT,                -- Tool-specific session ID (UUID)
  tmux_session TEXT,              -- tmux session name (for gemini)
  status TEXT DEFAULT 'created',  -- created|running|paused|completed|error
  cwd TEXT NOT NULL,
  task TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_active TEXT DEFAULT (datetime('now')),
  cost_usd REAL DEFAULT 0,
  turns INTEGER DEFAULT 0,
  metadata TEXT                   -- JSON blob for tool-specific data
);

CREATE INDEX idx_tool ON agent_sessions(tool);
CREATE INDEX idx_status ON agent_sessions(status);
CREATE INDEX idx_session_id ON agent_sessions(session_id);
```

### Key Recommendations

1. **Claude Code is the primary tool** -- Use the TypeScript SDK directly. It has the most mature session management with full programmatic control, JSON streaming, session forking, and cost tracking.

2. **Codex CLI is second** -- Use `codex exec --json` for structured JSONL output. Session resume works well via `codex exec resume <session_id>`. Always write prompts to files and pipe via stdin to avoid shell escaping issues.

3. **Gemini CLI is the most limited** -- No SDK, no structured output, no programmatic session API. Use tmux as the process isolation layer. Parse `--list-sessions` text output. Consider monitoring `~/.gemini/tmp/<hash>/chats/` for session files directly.

4. **Session ID capture** -- For Claude (SDK: `message.session_id`), for Codex (parse `thread_id` from JSONL), for Gemini (parse UUID from `--list-sessions` or scan filesystem).

5. **Process management** -- Use PM2 or tmux for long-running agents. Never start bare `pnpm dev` or similar processes. Each agent should be a managed subprocess.

6. **Cost tracking** -- Claude SDK provides `total_cost_usd` in result messages. Codex provides token counts in JSONL. Gemini provides token stats via `/stats` command.

7. **Error recovery** -- All three tools support resuming after crashes. Store session IDs in the registry immediately upon creation so they can be resumed even if the Agent Monitor process crashes.

8. **Session cleanup** -- Implement retention policies: auto-delete sessions older than N days, cap maximum stored sessions. Claude and Gemini both support this natively; Codex requires manual cleanup of `~/.codex/sessions/`.

---

## Appendix: Quick Reference Commands

### Start + Capture Session ID

```bash
# Claude Code
SESSION=$(claude -p "task" --output-format json | jq -r '.session_id')

# Codex CLI (parse thread_id from JSONL stream)
# The thread_id appears in the thread.started event

# Gemini CLI (no direct way; must parse filesystem)
# Check ~/.gemini/tmp/*/chats/ for newest file after running
```

### Resume Session

```bash
# Claude Code
claude -p "continue" --resume "$SESSION_ID"

# Codex CLI
codex exec resume "$SESSION_ID" "follow-up instructions"

# Gemini CLI
gemini --resume "$SESSION_UUID"
```

### List Sessions

```bash
# Claude Code (parse filesystem -- no CLI command)
# Check ~/.claude/history.jsonl or scan ~/.claude/projects/

# Codex CLI (interactive only, or scan filesystem)
# Check ~/.codex/sessions/ directory tree

# Gemini CLI
gemini --list-sessions
```

---

## Appendix: Full Source Links

### Claude Code

- https://code.claude.com/docs/en/cli-reference
- https://platform.claude.com/docs/en/agent-sdk/sessions
- https://platform.claude.com/docs/en/agent-sdk/typescript
- https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
- https://code.claude.com/docs/en/headless
- https://github.com/ruvnet/claude-flow/wiki/session-persistence
- https://www.vincentschmalbach.com/migrate-claude-code-sessions-to-a-new-computer/
- https://deepwiki.com/anthropics/claude-code/2.4-session-management
- https://claudelog.com/faqs/what-is-resume-flag-in-claude-code/

### Gemini CLI

- https://geminicli.com/docs/cli/session-management/
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
- https://developers.googleblog.com/pick-up-exactly-where-you-left-off-with-session-management-in-gemini-cli/
- https://geminicli.com/docs/cli/commands/
- https://google-gemini.github.io/gemini-cli/docs/cli/commands.html
- https://github.com/google-gemini/gemini-cli/issues/8944

### Codex CLI

- https://developers.openai.com/codex/cli/features/
- https://developers.openai.com/codex/cli/reference/
- https://developers.openai.com/codex/noninteractive/
- https://github.com/openai/codex/discussions/1076
- https://developers.openai.com/codex/cli/slash-commands/

### Other Tools & Frameworks

- https://github.com/Dicklesworthstone/coding_agent_session_search
- https://github.com/Dicklesworthstone/ntm
- https://www.npmjs.com/package/node-tmux
- https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/
- https://github.com/hoangsonww/AI-Agents-Orchestrator
- https://aider.chat/docs/faq.html
