# SDK Agents Design

## Overview

The Claude Agent SDK supports `Options.agents` for programmatically defining custom subagents that can be invoked via the built-in Agent tool. This is distinct from Agendo's `start_agent_session` MCP tool approach.

## AgentDefinition Type

```typescript
type AgentDefinition = {
  description: string; // When to use this agent (natural language)
  prompt: string; // The agent's system prompt
  tools?: string[]; // Allowed tool names (inherits parent if omitted)
  disallowedTools?: string[]; // Explicitly blocked tools
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit'; // Model selection
  mcpServers?: AgentMcpServerSpec[]; // MCP servers for this agent
  criticalSystemReminder_EXPERIMENTAL?: string; // High-priority system instruction
  skills?: string[]; // Skills to preload
  maxTurns?: number; // Max API round-trips before stopping
};
```

There is also an `agent` option to set the main thread's agent:

```typescript
Options.agent?: string;           // Name of agent to use for main thread
Options.agents?: Record<string, AgentDefinition>;  // Agent definitions
```

## SDK Agents vs Agendo's Current Approach

### Agendo's Current Approach: `start_agent_session` MCP Tool

How Agendo currently handles subagents:

1. The main agent calls `start_agent_session` MCP tool
2. Agendo spawns a **separate session process** (separate Claude/Codex/Gemini instance)
3. The subagent runs independently with its own session lifecycle
4. Communication happens via MCP tools (`add_progress_note`, `update_task`)

### SDK Agents: In-Process Subagents

How SDK agents work:

1. Agent definitions are passed in `Options.agents` at session creation
2. Claude's built-in **Agent tool** (formerly "Task tool") can invoke them
3. The subagent runs **within the same Claude process** as a nested conversation
4. The parent agent sees the subagent's result as the Agent tool's output
5. Subagent lifecycle events fire hooks: `SubagentStart`, `SubagentStop`

### Comparison

| Aspect                | Agendo `start_agent_session`           | SDK `agents`                            |
| --------------------- | -------------------------------------- | --------------------------------------- |
| **Process model**     | Separate OS process                    | Same process, nested conversation       |
| **Multi-agent**       | Any agent type (Claude, Codex, Gemini) | Claude subagents only                   |
| **Lifecycle**         | Independent session with full state    | Nested within parent turn               |
| **Communication**     | Async via MCP (task notes, status)     | Sync — parent waits for result          |
| **Tool restrictions** | Per-session via capability config      | Per-agent via `tools`/`disallowedTools` |
| **Model control**     | Per-session via `model` field          | Per-agent: sonnet/opus/haiku/inherit    |
| **Cost control**      | `maxBudgetUsd` per session             | `maxTurns` per agent invocation         |
| **Observability**     | Full session event stream              | Hook events (SubagentStart/Stop)        |
| **Context sharing**   | None (separate processes)              | Shares session context                  |
| **Concurrency**       | Parallel sessions possible             | Sequential within parent turn           |

## Use Cases Where SDK Agents Are Better

### 1. Code Reviewer Subagent

A lightweight reviewer that runs within the same session:

```typescript
sdkAgents: {
  'code-reviewer': {
    description: 'Reviews code changes for bugs, style, and security issues',
    prompt: 'You are a code reviewer. Analyze the given code changes and report issues.',
    tools: ['Read', 'Grep', 'Glob'],  // read-only tools
    disallowedTools: ['Bash', 'Edit', 'Write'],  // no modifications
    model: 'haiku',  // cheaper model for review
    maxTurns: 5,
  }
}
```

**Why SDK agents win**: The reviewer needs the parent's context (which files were changed, the task description). Spawning a separate session would lose this context.

### 2. Test Runner Subagent

```typescript
sdkAgents: {
  'test-runner': {
    description: 'Runs tests and reports results',
    prompt: 'Run the relevant tests for recent changes. Report pass/fail with details.',
    tools: ['Bash', 'Read', 'Glob'],
    model: 'haiku',
    maxTurns: 10,
  }
}
```

**Why SDK agents win**: Fast turnaround — no session startup overhead.

### 3. Research/Explore Subagent

```typescript
sdkAgents: {
  'explorer': {
    description: 'Explores the codebase to find relevant files and patterns',
    prompt: 'Search the codebase to answer questions about architecture and patterns.',
    tools: ['Read', 'Grep', 'Glob'],
    model: 'haiku',
    maxTurns: 15,
  }
}
```

**Note**: Claude already has a built-in "Explore" subagent. Custom agents could extend this with domain-specific prompts.

## Use Cases Where Agendo's Approach Is Better

1. **Cross-agent orchestration** — Delegating work from Claude to Codex or Gemini requires separate processes
2. **Long-running tasks** — Tasks that take 10+ minutes benefit from independent sessions with their own lifecycle
3. **Parallel execution** — Multiple agents working simultaneously on different subtasks
4. **Independent observability** — Each agent gets its own session event stream in the Agendo UI
5. **Fault isolation** — A crashed subagent doesn't take down the parent session

## Recommended Strategy

Use **both approaches** for different scenarios:

- **SDK agents** for quick, focused subtasks within a Claude session (review, explore, test)
- **Agendo sessions** for independent work units, cross-agent delegation, and long-running tasks

## Current Implementation

The passthrough is implemented in:

- `SpawnOpts.sdkAgents` in `types.ts` — accepts agent definitions
- `SpawnOpts.sdkAgent` in `types.ts` — sets main thread agent name
- `buildSdkOptions()` in `build-sdk-options.ts` — passes `agents` and `agent` to SDK `Options`

## Future Work

1. **Agent templates** — Define reusable agent definitions in capability config or project settings
2. **Dynamic agent injection** — Let session-runner compose agent definitions based on task context
3. **Hybrid orchestration** — Main agent uses SDK subagents for quick tasks, `start_agent_session` for heavy work
4. **SubagentStart/Stop hooks** — Use SDK hooks to track subagent activity in the Agendo event stream
5. **Agent-level MCP** — Pass specific MCP servers to subagents via `mcpServers` in AgentDefinition
