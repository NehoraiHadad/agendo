# Agent Monitor: AI Agent Task Management Research

> Comprehensive research on AI CLI agent task management, Claude Code team orchestration,
> MCP server integration, and multi-agent patterns for building "Agent Monitor" — a web UI
> task manager for AI agents.
>
> **Date**: 2026-02-17
> **Status**: Research complete

---

## Table of Contents

1. [Claude Code Teams/Swarm Mechanism](#1-claude-code-teamsswarm-mechanism)
2. [MCP Server as Agent-Monitor API](#2-mcp-server-as-agent-monitor-api)
3. [Agent-Initiated Execution](#3-agent-initiated-execution)
4. [Existing Multi-Agent Orchestration Patterns](#4-existing-multi-agent-orchestration-patterns)
5. [Claude Code --mcp-config for Custom Tools](#5-claude-code---mcp-config-for-custom-tools)
6. [Webhook/API Approach (Alternative to MCP)](#6-webhookapi-approach-alternative-to-mcp)
7. [Architecture Proposal for Agent Monitor](#7-architecture-proposal-for-agent-monitor)
8. [Comparison of Approaches](#8-comparison-of-approaches)
9. [Sources](#9-sources)

---

## 1. Claude Code Teams/Swarm Mechanism

### 1.1 Overview

Claude Code Agent Teams is an experimental feature released on February 5, 2026,
alongside Claude Opus 4.6. It enables one Claude Code session (the "team lead") to
spawn multiple independent "teammate" sessions that communicate directly, share a
task list, and self-coordinate.

**Enable agent teams:**

```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### 1.2 Architecture

```
+------------------------------------------------------+
|                    TEAM LEAD                          |
|  (Main Claude Code session)                          |
|                                                      |
|  Tools: TeamCreate, TaskCreate, TaskUpdate,          |
|         TaskList, SendMessage, Task                  |
+------+--------+--------+--------+-------------------+
       |        |        |        |
       v        v        v        v
  +--------+ +--------+ +--------+ +--------+
  |Teammate| |Teammate| |Teammate| |Teammate|
  |  "FE"  | | "BE"   | | "Test" | | "Sec"  |
  +--------+ +--------+ +--------+ +--------+
       |        |        |        |
       +--------+--------+--------+
                |
       +--------v--------+
       |  SHARED TASK     |
       |  LIST            |
       |  (JSON on disk)  |
       +--------+---------+
                |
       +--------v--------+
       |  MAILBOX SYSTEM  |
       |  (Inter-agent    |
       |   messaging)     |
       +-----------------+
```

**Components:**

| Component     | Role                                                    |
| :------------ | :------------------------------------------------------ |
| **Team lead** | Creates team, spawns teammates, coordinates work        |
| **Teammates** | Separate Claude Code instances with own context windows |
| **Task list** | Shared list of work items (JSON files on disk)          |
| **Mailbox**   | Messaging system for communication between agents       |

**Storage locations:**

- Team config: `~/.claude/teams/{team-name}/config.json`
- Task list: `~/.claude/tasks/{team-name}/N.json`

### 1.3 TeammateTool Operations (13 operations)

| Operation           | Purpose                           |
| :------------------ | :-------------------------------- |
| **spawnTeam**       | Create team; you become leader    |
| **discoverTeams**   | List available teams to join      |
| **requestJoin**     | Request team membership           |
| **approveJoin**     | Leader accepts join request       |
| **rejectJoin**      | Leader declines join request      |
| **write**           | Message specific teammate         |
| **broadcast**       | Message all teammates (expensive) |
| **requestShutdown** | Leader orders teammate exit       |
| **approveShutdown** | Teammate confirms shutdown        |
| **rejectShutdown**  | Teammate declines shutdown        |
| **approvePlan**     | Leader approves teammate plan     |
| **rejectPlan**      | Leader rejects with feedback      |
| **cleanup**         | Remove team resources             |

### 1.4 Task Management System

**TaskCreate** creates work items as JSON files:

```json
{
  "id": "1",
  "subject": "Review authentication module",
  "status": "in_progress",
  "owner": "security-reviewer",
  "blockedBy": [],
  "blocks": ["3"],
  "createdAt": 1706000000000
}
```

- **TaskList()** — displays all tasks (ID, status, subject, owner)
- **TaskGet()** — retrieves full task details including dependencies
- **TaskUpdate()** — modifies status, ownership, blocking relationships

Tasks have three states: **pending**, **in_progress**, **completed**.
Dependencies use `addBlockedBy` — auto-unblock when blocking tasks complete.
File locking prevents race conditions when multiple teammates claim simultaneously.

### 1.5 Communication Protocol

**Message types:**

- `message` — send to one specific teammate
- `broadcast` — send to all teammates (costs scale with team size)

**Structured message formats (JSON in text field):**

- `shutdown_request` — leader orders exit with reason and requestId
- `shutdown_approved` — teammate confirms shutdown
- `idle_notification` — auto-sent when teammate stops
- `task_completed` — reports task completion
- `plan_approval_request` — teammate submits plan for review
- `join_request` — agent requests team membership

### 1.6 Team Config Format

```json
{
  "name": "my-project",
  "leadAgentId": "team-lead@my-project",
  "members": [
    {
      "agentId": "team-lead@my-project",
      "name": "team-lead",
      "agentType": "team-lead",
      "color": "#4A90D9",
      "backendType": "in-process"
    }
  ]
}
```

### 1.7 Subagents vs Agent Teams

| Aspect            | Subagents                            | Agent Teams                          |
| :---------------- | :----------------------------------- | :----------------------------------- |
| **Context**       | Own window; results return to caller | Own window; fully independent        |
| **Communication** | Report back to main agent only       | Message each other directly          |
| **Coordination**  | Main agent manages all work          | Shared task list, self-coordination  |
| **Best for**      | Focused tasks, result-only           | Complex work requiring collaboration |
| **Token cost**    | Lower: results summarized            | Higher: each is a separate instance  |
| **Nesting**       | Cannot spawn sub-subagents           | Cannot spawn nested teams            |

### 1.8 Subagents in the Claude Agent SDK

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) allows programmatic subagent
definition:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'Review the authentication module for security issues',
  options: {
    allowedTools: ['Read', 'Grep', 'Glob', 'Task'],
    agents: {
      'code-reviewer': {
        description: 'Expert code review specialist.',
        prompt: `You are a code review specialist with expertise in
                 security, performance, and best practices.`,
        tools: ['Read', 'Grep', 'Glob'],
        model: 'sonnet',
      },
      'test-runner': {
        description: 'Runs and analyzes test suites.',
        prompt: `You are a test execution specialist.`,
        tools: ['Bash', 'Read', 'Grep'],
      },
    },
  },
})) {
  if ('result' in message) console.log(message.result);
}
```

**AgentDefinition interface:**

```typescript
type AgentDefinition = {
  description: string; // When to use this agent (required)
  tools?: string[]; // Allowed tools; omit = inherit all
  prompt: string; // System prompt (required)
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
};
```

### 1.9 Hooks for External Integration

Claude Code hooks provide event-driven integration points:

- **TeammateIdle** — fires when a teammate finishes and goes idle
- **TaskCompleted** — fires when a task is marked complete via TaskUpdate
- **SubagentStart/SubagentStop** — fires when subagents start/stop
- **Notification** — general notification events
- **PostToolUse** — fires after any tool completes

**TaskCompleted hook input includes:**

- `task_id`, `task_subject`, `task_description`
- `teammate_name`, `team_name`

These hooks can call external APIs (e.g., Agent Monitor) to sync state.

### 1.10 Can External Systems Participate?

**Current limitations:**

- No public API to observe or join Claude Code teams from outside
- Team coordination is entirely file-based (JSON on local disk)
- No WebSocket/HTTP interface to the team protocol
- External systems cannot directly create/update tasks in a Claude team

**Integration points available:**

- Hooks (TeammateIdle, TaskCompleted) can POST to external APIs
- MCP servers loaded by teammates can communicate with external systems
- The Claude Agent SDK `query()` function can spawn agents with custom MCP servers
- File watching on `~/.claude/teams/` and `~/.claude/tasks/` directories

---

## 2. MCP Server as Agent-Monitor API

### 2.1 Architecture Overview

```
+------------------+     MCP Protocol      +-------------------+
|                  |  (stdio or HTTP)       |                   |
|  AI Agent        |<--------------------->|  Agent Monitor     |
|  (Claude/Gemini/ |                       |  MCP Server        |
|   Codex)         |                       |                   |
|                  |   Tool calls:         |   REST API calls:  |
|  create_task()   |   ----------------->  |   POST /api/tasks  |
|  update_task()   |   ----------------->  |   PATCH /api/tasks |
|  list_tasks()    |   ----------------->  |   GET /api/tasks   |
|  create_subtask()|   ----------------->  |   POST /api/subtask|
|  assign_task()   |   ----------------->  |   PATCH /api/assign|
|                  |                       |                   |
+------------------+                       +-------------------+
                                                    |
                                                    v
                                           +-------------------+
                                           |  Agent Monitor    |
                                           |  Web UI           |
                                           |  (Next.js app)    |
                                           +-------------------+
```

### 2.2 MCP Server Implementation in TypeScript

Using `@modelcontextprotocol/sdk` (current version v1.x, stable v2 expected Q1 2026):

```typescript
// agent-monitor-mcp-server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const AGENT_MONITOR_API = process.env.AGENT_MONITOR_URL || 'http://localhost:4100';

const server = new McpServer({
  name: 'agent-monitor',
  version: '1.0.0',
});

// --- Tool: create_task ---
server.registerTool(
  'create_task',
  {
    title: 'Create Task',
    description: 'Create a new task on the Agent Monitor board',
    inputSchema: {
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
      assignee: z.string().optional().describe('Agent slug to assign to'),
      parentTaskId: z.string().optional().describe('Parent task ID for subtasks'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
  },
  async ({ title, description, priority, assignee, parentTaskId, tags }) => {
    const res = await fetch(`${AGENT_MONITOR_API}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        priority,
        assignee,
        parentTaskId,
        tags,
        status: 'todo',
        createdBy: 'mcp-agent',
      }),
    });
    const task = await res.json();
    return {
      content: [
        {
          type: 'text',
          text: `Task created: #${task.id} "${task.title}" [${task.status}]`,
        },
      ],
    };
  },
);

// --- Tool: update_task ---
server.registerTool(
  'update_task',
  {
    title: 'Update Task',
    description: "Update a task's status, assignee, or other fields",
    inputSchema: {
      taskId: z.string().describe('Task ID to update'),
      status: z.enum(['todo', 'in_progress', 'in_review', 'done', 'blocked']).optional(),
      assignee: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    },
  },
  async ({ taskId, ...updates }) => {
    const res = await fetch(`${AGENT_MONITOR_API}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const task = await res.json();
    return {
      content: [
        {
          type: 'text',
          text: `Task #${task.id} updated: status=${task.status}`,
        },
      ],
    };
  },
);

// --- Tool: list_tasks ---
server.registerTool(
  'list_tasks',
  {
    title: 'List Tasks',
    description: 'List tasks from the Agent Monitor board with optional filters',
    inputSchema: {
      status: z.enum(['todo', 'in_progress', 'in_review', 'done', 'blocked', 'all']).default('all'),
      assignee: z.string().optional(),
      parentTaskId: z.string().optional(),
    },
  },
  async ({ status, assignee, parentTaskId }) => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (assignee) params.set('assignee', assignee);
    if (parentTaskId) params.set('parentTaskId', parentTaskId);

    const res = await fetch(`${AGENT_MONITOR_API}/api/tasks?${params.toString()}`);
    const tasks = await res.json();

    const formatted = tasks
      .map((t: any) => `#${t.id} [${t.status}] ${t.title} (${t.assignee || 'unassigned'})`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: formatted || 'No tasks found.',
        },
      ],
    };
  },
);

// --- Tool: create_subtask ---
server.registerTool(
  'create_subtask',
  {
    title: 'Create Subtask',
    description: 'Break a task into a subtask',
    inputSchema: {
      parentTaskId: z.string().describe('Parent task ID'),
      title: z.string().describe('Subtask title'),
      description: z.string().optional(),
      assignee: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    },
  },
  async ({ parentTaskId, title, description, assignee, priority }) => {
    const res = await fetch(`${AGENT_MONITOR_API}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        priority,
        assignee,
        parentTaskId,
        status: 'todo',
        createdBy: 'mcp-agent',
      }),
    });
    const task = await res.json();
    return {
      content: [
        {
          type: 'text',
          text: `Subtask created: #${task.id} "${task.title}" under parent #${parentTaskId}`,
        },
      ],
    };
  },
);

// --- Tool: assign_task ---
server.registerTool(
  'assign_task',
  {
    title: 'Assign Task',
    description: 'Assign a task to a specific agent',
    inputSchema: {
      taskId: z.string().describe('Task ID to assign'),
      agentSlug: z.string().describe("Agent slug (e.g., 'claude', 'codex', 'gemini')"),
    },
  },
  async ({ taskId, agentSlug }) => {
    const res = await fetch(`${AGENT_MONITOR_API}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignee: agentSlug }),
    });
    const task = await res.json();
    return {
      content: [
        {
          type: 'text',
          text: `Task #${task.id} assigned to ${agentSlug}`,
        },
      ],
    };
  },
);

// --- Tool: spawn_agent ---
server.registerTool(
  'spawn_agent',
  {
    title: 'Spawn Agent',
    description: 'Request Agent Monitor to spawn a new agent instance for a task',
    inputSchema: {
      taskId: z.string().describe('Task ID for the agent to work on'),
      agentType: z.enum(['claude', 'codex', 'gemini']).describe('Which AI agent to spawn'),
      model: z.string().optional().describe('Specific model to use'),
    },
  },
  async ({ taskId, agentType, model }) => {
    const res = await fetch(`${AGENT_MONITOR_API}/api/agents/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, agentType, model }),
    });
    const result = await res.json();
    return {
      content: [
        {
          type: 'text',
          text: `Agent spawned: ${agentType} for task #${taskId} (pid: ${result.pid})`,
        },
      ],
    };
  },
);

// --- Start server ---
const transport = new StdioServerTransport();
await server.connect(transport);
```

### 2.3 Alternative: HTTP Transport MCP Server

For remote/shared access, use Streamable HTTP transport:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import express from 'express';

const app = express();
const server = new McpServer({ name: 'agent-monitor', version: '1.0.0' });

// Register all tools (same as above)...

// Create HTTP transport
app.use('/mcp', async (req, res) => {
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);
  // Handle the request...
});

app.listen(4101, () => {
  console.log('Agent Monitor MCP server on http://localhost:4101/mcp');
});
```

### 2.4 How Each CLI Connects to the MCP Server

#### Claude Code

**Option A: CLI command**

```bash
claude mcp add agent-monitor --transport stdio -- \
  node /path/to/agent-monitor-mcp-server.js
```

**Option B: `.mcp.json` in project root**

```json
{
  "mcpServers": {
    "agent-monitor": {
      "command": "node",
      "args": ["/path/to/agent-monitor-mcp-server.js"],
      "env": {
        "AGENT_MONITOR_URL": "http://localhost:4100"
      }
    }
  }
}
```

**Option C: HTTP transport**

```bash
claude mcp add agent-monitor --transport http http://localhost:4101/mcp
```

**Option D: User-scope (available in all projects)**

```bash
claude mcp add agent-monitor --scope user --transport stdio -- \
  node /path/to/agent-monitor-mcp-server.js
```

#### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "agent-monitor": {
      "command": "node",
      "args": ["/path/to/agent-monitor-mcp-server.js"],
      "env": {
        "AGENT_MONITOR_URL": "http://localhost:4100"
      }
    }
  }
}
```

Or for HTTP:

```json
{
  "mcpServers": {
    "agent-monitor": {
      "httpUrl": "http://localhost:4101/mcp"
    }
  }
}
```

#### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.agent-monitor]
command = "node"
args = ["/path/to/agent-monitor-mcp-server.js"]

[mcp_servers.agent-monitor.env]
AGENT_MONITOR_URL = "http://localhost:4100"
```

Or for HTTP:

```toml
[mcp_servers.agent-monitor]
url = "http://localhost:4101/mcp"
```

### 2.5 SDK MCP Server (In-Process)

The Claude Agent SDK supports in-process MCP servers that do not require a
separate process:

```typescript
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const agentMonitorServer = createSdkMcpServer({
  name: 'agent-monitor',
  version: '1.0.0',
  tools: [
    tool(
      'create_task',
      'Create a task on Agent Monitor',
      { title: z.string(), priority: z.enum(['low', 'medium', 'high']) },
      async ({ title, priority }) => {
        const res = await fetch('http://localhost:4100/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, priority, status: 'todo' }),
        });
        const task = await res.json();
        return {
          content: [{ type: 'text', text: `Task #${task.id} created` }],
        };
      },
    ),
    tool(
      'update_task',
      'Update a task on Agent Monitor',
      {
        taskId: z.string(),
        status: z.enum(['todo', 'in_progress', 'done']),
      },
      async ({ taskId, status }) => {
        await fetch(`http://localhost:4100/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        return {
          content: [{ type: 'text', text: `Task #${taskId} => ${status}` }],
        };
      },
    ),
  ],
});

// Pass to every spawned agent via query()
for await (const message of query({
  prompt: 'Build the user authentication module. Break it into subtasks.',
  options: {
    mcpServers: {
      'agent-monitor': agentMonitorServer,
    },
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Grep',
      'Glob',
      'Task',
      'mcp__agent-monitor__*',
    ],
    agents: {
      'task-planner': {
        description: 'Plans work and creates subtasks on Agent Monitor',
        prompt: `You are a task planner. When given a complex task, break it
                 into subtasks using the create_task tool. Assign each subtask
                 to the appropriate agent type.`,
        tools: [
          'Read',
          'Grep',
          'Glob',
          'mcp__agent-monitor__create_task',
          'mcp__agent-monitor__list_tasks',
        ],
      },
    },
  },
})) {
  if ('result' in message) console.log(message.result);
}
```

---

## 3. Agent-Initiated Execution

### 3.1 Spawning Agents from Agent Monitor

When an agent creates a task and assigns it to another agent type, Agent Monitor
can spawn that agent:

```
+---------+     MCP: create_task()     +---------------+
| Claude  |  ----------------------->  | Agent Monitor |
| (agent) |  assign: "codex"           | MCP Server    |
+---------+                            +-------+-------+
                                               |
                                               v
                                       +---------------+
                                       | Agent Monitor |
                                       | Backend       |
                                       +-------+-------+
                                               |
                        spawn_agent("codex", taskId)
                                               |
                                               v
                                       +---------------+
                                       | Codex CLI     |
                                       | (subprocess)  |
                                       +---------------+
```

### 3.2 Implementation: Spawning Agents from the Backend

```typescript
// agent-spawner.ts
import { spawn } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

interface SpawnOptions {
  taskId: string;
  agentType: 'claude' | 'codex' | 'gemini';
  model?: string;
  task: { title: string; description: string };
}

// Track active agents for concurrency control
const activeAgents = new Map<string, { pid: number; taskId: string }>();
const MAX_CONCURRENT_AGENTS = 3;
const SPAWN_DEPTH_LIMIT = 3;

export async function spawnAgent(options: SpawnOptions): Promise<number> {
  // --- Guard: concurrency limit ---
  if (activeAgents.size >= MAX_CONCURRENT_AGENTS) {
    throw new Error(`Concurrency limit reached (${MAX_CONCURRENT_AGENTS} agents active)`);
  }

  // --- Guard: depth limit (prevent infinite loops) ---
  const depth = await getTaskDepth(options.taskId);
  if (depth >= SPAWN_DEPTH_LIMIT) {
    throw new Error(
      `Spawn depth limit reached (${SPAWN_DEPTH_LIMIT}). ` +
        `Task #${options.taskId} is ${depth} levels deep.`,
    );
  }

  const prompt = buildPromptForTask(options.task);

  switch (options.agentType) {
    case 'claude':
      return spawnClaudeAgent(options, prompt);
    case 'codex':
      return spawnCodexAgent(options, prompt);
    case 'gemini':
      return spawnGeminiAgent(options, prompt);
  }
}

function spawnClaudeAgent(options: SpawnOptions, prompt: string): number {
  // Option A: Use Claude Agent SDK (preferred for programmatic control)
  // This runs in the same Node.js process as Agent Monitor.
  (async () => {
    for await (const message of query({
      prompt,
      options: {
        mcpServers: {
          'agent-monitor': {
            command: 'node',
            args: ['/path/to/agent-monitor-mcp-server.js'],
            env: { AGENT_MONITOR_URL: 'http://localhost:4100' },
          },
        },
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'mcp__agent-monitor__*'],
        permissionMode: 'acceptEdits',
        model: options.model || 'opus',
      },
    })) {
      if ('result' in message) {
        // Update task status to done
        await fetch(`http://localhost:4100/api/tasks/${options.taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        });
      }
    }
  })();

  return process.pid; // Simplified; real impl tracks child processes
}

function spawnCodexAgent(options: SpawnOptions, prompt: string): number {
  // Write prompt to file (Codex requires stdin piping for long prompts)
  const promptFile = `/tmp/codex-prompt-${options.taskId}.txt`;
  require('fs').writeFileSync(promptFile, prompt);

  const child = spawn(
    '/home/ubuntu/.bun/bin/codex',
    [
      '-C',
      process.cwd(),
      '--approval-mode',
      'auto-edit',
      '-q',
      '-', // Read from stdin
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      },
    },
  );

  // Pipe prompt file to stdin
  const promptStream = require('fs').createReadStream(promptFile);
  promptStream.pipe(child.stdin);

  activeAgents.set(options.taskId, { pid: child.pid!, taskId: options.taskId });

  child.on('exit', () => {
    activeAgents.delete(options.taskId);
  });

  return child.pid!;
}

function spawnGeminiAgent(options: SpawnOptions, prompt: string): number {
  const child = spawn('gemini', ['-p', prompt], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeAgents.set(options.taskId, { pid: child.pid!, taskId: options.taskId });
  child.on('exit', () => activeAgents.delete(options.taskId));

  return child.pid!;
}

// --- Depth tracking to prevent infinite spawn loops ---
async function getTaskDepth(taskId: string): Promise<number> {
  let depth = 0;
  let currentId: string | null = taskId;

  while (currentId) {
    const res = await fetch(`http://localhost:4100/api/tasks/${currentId}`);
    const task = await res.json();
    currentId = task.parentTaskId || null;
    depth++;
  }

  return depth;
}

function buildPromptForTask(task: { title: string; description: string }): string {
  return `You are working on a task from Agent Monitor.

TASK: ${task.title}
DESCRIPTION: ${task.description}

INSTRUCTIONS:
1. Use the agent-monitor MCP tools to update your task status to "in_progress"
2. Complete the work described above
3. If you need to break this into subtasks, use create_subtask
4. When done, update your task status to "done"

IMPORTANT:
- Do NOT spawn additional agents unless absolutely necessary
- Do NOT create recursive subtasks that mirror this task
- Focus on completing the work directly`;
}
```

### 3.3 Preventing Infinite Loops

**Strategy 1: Depth Limits**
Track parent-child task relationships. Refuse to spawn if depth exceeds limit.

**Strategy 2: Budget Caps**

```typescript
// Per-task budget
const TASK_BUDGET_USD = 5.0;

// In Claude Agent SDK:
query({
  prompt,
  options: {
    maxBudgetUsd: TASK_BUDGET_USD,
    maxTurns: 50,
  },
});
```

**Strategy 3: Spawn Cooldown**

```typescript
const spawnCooldown = new Map<string, number>(); // agentType -> lastSpawnTime
const COOLDOWN_MS = 30_000; // 30 seconds

function canSpawn(agentType: string): boolean {
  const last = spawnCooldown.get(agentType) || 0;
  return Date.now() - last > COOLDOWN_MS;
}
```

**Strategy 4: Task Deduplication**
Before creating a task, check if an identical or near-identical task already exists:

```typescript
server.registerTool("create_task", { ... }, async (input) => {
  // Check for duplicate
  const existing = await fetch(
    `${API}/api/tasks?title=${encodeURIComponent(input.title)}&status=todo,in_progress`
  );
  const tasks = await existing.json();
  if (tasks.length > 0) {
    return {
      content: [{
        type: "text",
        text: `Duplicate detected: task #${tasks[0].id} already exists with title "${tasks[0].title}"`,
      }],
    };
  }
  // ... create the task
});
```

**Strategy 5: Agent Cannot Spawn Same Type**
An agent of type X should never be allowed to spawn another agent of type X
for the same task tree.

### 3.4 Concurrency and Resource Management

```
+-------------------------------------------+
|          Resource Budget                   |
|                                            |
|  Max concurrent agents: 3                 |
|  Max total memory: 12GB (server limit)    |
|  Per-agent memory: ~2GB (NODE_OPTIONS)    |
|  Per-agent token budget: $5.00            |
|  Per-agent max turns: 50                  |
|  Spawn depth limit: 3                     |
|  Spawn cooldown: 30s per agent type       |
+-------------------------------------------+
```

---

## 4. Existing Multi-Agent Orchestration Patterns

### 4.1 AgentsBoard (JIRA-like for AI Agents)

**Repository**: github.com/Justmalhar/AgentsBoard

A Next.js Kanban board specifically designed for AI agent task management:

- Users create tasks with descriptions, select AI agent, choose model
- Task lifecycle: Todo -> In Progress -> Done
- Uses OpenRouter API for multi-model support
- Automated state progression when agent completes work
- Markdown export for completed tasks

**Relevance to Agent Monitor**: Direct inspiration. AgentsBoard proves the
concept but is limited — agents cannot create their own tasks, and there is
no MCP integration. Agent Monitor adds bidirectional agent-task control.

### 4.2 CrewAI (Role-Based Multi-Agent)

CrewAI enables building "crews" of AI agents with:

- **Hierarchical delegation**: Manager agent coordinates worker agents
- **Role-based tasks**: Each agent has a defined role and tools
- **Task assignment**: Tasks map to agents via capabilities
- **Tool integration**: `BaseTool` interface for external system access

**Delegation model:**

```python
# CrewAI delegation example
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Researcher",
    goal="Find relevant information",
    allow_delegation=True
)

writer = Agent(
    role="Writer",
    goal="Write clear documentation"
)

task = Task(
    description="Research and document the API",
    agent=researcher  # Researcher can delegate to writer
)

crew = Crew(agents=[researcher, writer], tasks=[task])
```

**CrewAI now has an Enterprise MCP Server**, allowing external systems to
interact with CrewAI crews via MCP protocol.

### 4.3 LangGraph (Stateful Graph Orchestration)

LangGraph patterns relevant to Agent Monitor:

**Supervisor Pattern:**

```
         +------------+
         | Supervisor |
         +-----+------+
               |
     +---------+---------+
     |         |         |
  +--v--+  +--v--+  +--v--+
  |Agent|  |Agent|  |Agent|
  |  A  |  |  B  |  |  C  |
  +-----+  +-----+  +-----+
```

- Supervisor decides which agent acts next
- Shared state graph between agents
- Checkpointing for persistence and recovery

**Scatter-Gather Pattern:**

- Distribute subtasks to multiple agents
- Collect all results
- Synthesize final output

**Pipeline Pattern:**

- Sequential agents, each processing the output of the previous
- Dependencies between stages

### 4.4 Claude-Flow (Community Framework)

**Repository**: github.com/ruvnet/claude-flow

Community-built orchestration platform for Claude:

- 87 MCP tools for AI orchestration
- 54+ specialized agents
- Distributed swarm intelligence
- Shared memory and consensus
- Tools in `mcp__claude-flow__` namespace

**Relevance**: Demonstrates that MCP-based orchestration at scale is viable.
Agent Monitor can learn from their tool taxonomy.

### 4.5 Microsoft Agent Framework / AutoGen

- Agents communicate in conversational turns
- Group chat orchestration (recommend <= 3 agents)
- Claude Agent SDK integration now available
- `azure-ai-agent` library supports multi-framework agents

### 4.6 Pattern Comparison

| Pattern          | Coordination     | State Sharing     | Delegation           |
| :--------------- | :--------------- | :---------------- | :------------------- |
| Claude Teams     | Task list + msgs | File-based JSON   | Lead assigns tasks   |
| Claude Subagents | Return values    | Context summaries | Task tool invocation |
| CrewAI           | Role-based       | Shared memory     | allow_delegation     |
| LangGraph        | Graph edges      | State dict        | Supervisor routing   |
| AutoGen          | Chat turns       | Chat history      | Speaker selection    |
| Agent Monitor    | External board   | Database/API      | MCP tool calls       |

---

## 5. Claude Code --mcp-config for Custom Tools

### 5.1 Passing MCP Config at Spawn Time

When Agent Monitor spawns a Claude Code instance, it must ensure the agent
has access to Agent Monitor's MCP server.

**Method 1: `.mcp.json` in project root (recommended for all agents)**

Place this file at the root of the project directory:

```json
{
  "mcpServers": {
    "agent-monitor": {
      "command": "node",
      "args": ["/home/ubuntu/projects/agent-monitor/mcp-server/index.js"],
      "env": {
        "AGENT_MONITOR_URL": "http://localhost:4100"
      }
    }
  }
}
```

Every Claude Code session in this project automatically loads the MCP server.
This includes spawned teammates and subagents (they load project context including
`.mcp.json` and `CLAUDE.md`).

**Method 2: User-scope config**

```bash
claude mcp add agent-monitor --scope user --transport stdio -- \
  node /home/ubuntu/projects/agent-monitor/mcp-server/index.js
```

This makes agent-monitor available in ALL projects for this user.

**Method 3: Claude Agent SDK `query()` with mcpServers**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: taskPrompt,
  options: {
    mcpServers: {
      'agent-monitor': {
        command: 'node',
        args: ['/home/ubuntu/projects/agent-monitor/mcp-server/index.js'],
        env: {
          AGENT_MONITOR_URL: 'http://localhost:4100',
        },
      },
    },
    allowedTools: ['mcp__agent-monitor__*', 'Read', 'Write', 'Edit', 'Bash'],
    permissionMode: 'acceptEdits',
  },
})) {
  // Process messages...
}
```

### 5.2 MCP Server Inheritance in Teams

From the official docs:

> "Teammates load project context automatically, including CLAUDE.md,
> MCP servers, and skills."

This means if agent-monitor's MCP server is configured in `.mcp.json`,
**every teammate in an agent team automatically gets access** to the
agent-monitor tools. This is a critical feature for our use case.

### 5.3 MCP Config for All Three CLIs

Here is a unified `.mcp.json`-compatible format that works across all
supported CLIs:

**For Claude Code** (`.mcp.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "agent-monitor": {
      "command": "node",
      "args": ["/abs/path/to/agent-monitor-mcp-server.js"],
      "env": { "AGENT_MONITOR_URL": "http://localhost:4100" }
    }
  }
}
```

**For Gemini CLI** (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "agent-monitor": {
      "command": "node",
      "args": ["/abs/path/to/agent-monitor-mcp-server.js"],
      "env": { "AGENT_MONITOR_URL": "http://localhost:4100" }
    }
  }
}
```

**For Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.agent-monitor]
command = "node"
args = ["/abs/path/to/agent-monitor-mcp-server.js"]

[mcp_servers.agent-monitor.env]
AGENT_MONITOR_URL = "http://localhost:4100"
```

### 5.4 Tool Naming Convention

MCP tools follow: `mcp__<server-name>__<tool-name>`

For agent-monitor:

- `mcp__agent-monitor__create_task`
- `mcp__agent-monitor__update_task`
- `mcp__agent-monitor__list_tasks`
- `mcp__agent-monitor__create_subtask`
- `mcp__agent-monitor__assign_task`
- `mcp__agent-monitor__spawn_agent`

---

## 6. Webhook/API Approach (Alternative to MCP)

### 6.1 REST API with Bash Tool

Instead of MCP, agents can call Agent Monitor's REST API directly using
the Bash tool (curl/fetch):

**In CLAUDE.md or agent prompt:**

````markdown
## Agent Monitor Integration

To interact with the task board, use these commands:

### Create a task

```bash
curl -s -X POST http://localhost:4100/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Task name", "status": "todo", "priority": "medium"}'
```
````

### Update task status

```bash
curl -s -X PATCH http://localhost:4100/api/tasks/TASK_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

### List tasks

```bash
curl -s http://localhost:4100/api/tasks?status=todo
```

```

### 6.2 Comparison: MCP vs REST API

| Aspect                | MCP Server                         | REST API (curl)                     |
|:--------------------- |:---------------------------------- |:----------------------------------- |
| **Structure**         | Formal tool schema with zod        | Free-form JSON in curl commands     |
| **Discovery**         | Agent auto-discovers tools         | Agent must read instructions        |
| **Validation**        | Input validated by MCP SDK         | No validation until server-side     |
| **Error handling**    | Structured error responses         | Raw HTTP error codes                |
| **Agent compatibility**| Claude, Gemini, Codex (all 3)     | Any agent with Bash access          |
| **Setup complexity**  | Moderate (MCP server + config)     | Low (just REST API + prompt)        |
| **Reliability**       | High (typed tools)                 | Medium (prompt engineering)         |
| **Token cost**        | Lower (tool call, not full curl)   | Higher (curl syntax in context)     |
| **Works without MCP** | No                                 | Yes (any agent)                     |

### 6.3 Recommendation: Dual Approach

Implement BOTH:
1. **MCP server** as the primary interface (structured, reliable)
2. **REST API** as fallback (works with any agent that has Bash access)

The REST API already needs to exist for the web UI, so the MCP server
is just a typed wrapper around the same endpoints.

---

## 7. Architecture Proposal for Agent Monitor

### 7.1 Full Architecture Diagram

```

+------------------------------------------------------------------+
| WEB BROWSER |
| |
| +------------------------------------------------------------+ |
| | Agent Monitor Web UI (Next.js) | |
| | | |
| | +----------+ +----------+ +----------+ +----------+ | |
| | | Kanban | | Agent | | Task | | Agent | | |
| | | Board | | Status | | Detail | | Spawn | | |
| | +----------+ +----------+ +----------+ +----------+ | |
| +----------------------------+--------------------------------+ |
| | |
| WebSocket / REST API |
+------------------------------------------------------------------+
|
v
+------------------------------------------------------------------+
| AGENT MONITOR BACKEND |
| (Next.js API Routes) |
| |
| +----------------+ +----------------+ +-------------------+ |
| | Task CRUD API | | Agent Spawner | | WebSocket Server | |
| | /api/tasks/_ | | /api/agents/_ | | Real-time updates | |
| +-------+--------+ +-------+--------+ +--------+----------+ |
| | | | |
| v v v |
| +----------------+ +----------------+ +-------------------+ |
| | Database | | Process Mgr | | Event Bus | |
| | (SQLite / | | (child_process | | (task.created, | |
| | Postgres) | | or PM2) | | task.updated, | |
| +----------------+ +----------------+ | agent.spawned) | |
| +-------------------+ |
+------------------------------------------------------------------+
| |
| | Spawns agents
| | with MCP config
v v
+------------------------------------------------------------------+
| AI AGENT LAYER |
| |
| +------------+ +------------+ +------------+ |
| | Claude | | Codex | | Gemini | |
| | Code | | CLI | | CLI | |
| | | | | | | |
| | MCP tools: | | MCP tools: | | MCP tools: | |
| | create_task| | create_task| | create_task| |
| | update_task| | update_task| | update_task| |
| | list_tasks | | list_tasks | | list_tasks | |
| +------+-----+ +------+-----+ +------+-----+ |
| | | | |
| +--------+--------+---------+-------+ |
| | | |
| v v |
| +-------------+ +-------------+ |
| | Agent Monitor| | Agent Monitor| |
| | MCP Server | | MCP Server | |
| | (stdio inst) | | (stdio inst) | |
| +------+------+ +------+------+ |
| | | |
| +--------+---------+ |
| | |
| REST API calls to |
| Agent Monitor Backend |
+------------------------------------------------------------------+

````

### 7.2 Data Model

```typescript
interface Task {
  id: string;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked";
  priority: "low" | "medium" | "high" | "critical";
  assignee?: string;          // Agent slug or null
  parentTaskId?: string;      // For subtasks
  createdBy: string;          // "user" | "claude" | "codex" | "gemini"
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  tags: string[];
  depth: number;              // Distance from root task (for loop prevention)
  metadata: {
    agentSessionId?: string;  // Claude session ID
    tokenCost?: number;       // Cost in USD
    turnCount?: number;       // Number of agent turns
  };
}

interface Agent {
  id: string;
  slug: string;               // "claude" | "codex" | "gemini"
  status: "idle" | "running" | "error" | "stopped";
  currentTaskId?: string;
  pid?: number;
  model?: string;
  startedAt?: Date;
  stoppedAt?: Date;
  tokenUsage?: {
    input: number;
    output: number;
    cost: number;
  };
}
````

### 7.3 Event Flow: Agent Breaks Down a Task

```
1. User creates task in UI:
   "Build user authentication with OAuth"

2. User assigns to Claude and clicks "Run"

3. Agent Monitor spawns Claude with prompt + MCP config

4. Claude reads the task via list_tasks:
   -> mcp__agent-monitor__list_tasks({ status: "in_progress" })

5. Claude creates subtasks:
   -> mcp__agent-monitor__create_subtask({
        parentTaskId: "task-1",
        title: "Set up OAuth provider configuration",
        assignee: "claude"
      })
   -> mcp__agent-monitor__create_subtask({
        parentTaskId: "task-1",
        title: "Implement login/callback routes",
        assignee: "claude"
      })
   -> mcp__agent-monitor__create_subtask({
        parentTaskId: "task-1",
        title: "Write integration tests",
        assignee: "codex"     // Assigns to Codex!
      })

6. Agent Monitor UI updates in real-time (WebSocket)

7. For the "codex" subtask, Agent Monitor can:
   a) Auto-spawn Codex (if auto-spawn enabled)
   b) Show "Spawn Codex" button for user to confirm

8. Codex starts working on tests, updates status via MCP

9. Claude completes its subtasks, updates status

10. When all subtasks are "done", parent task auto-completes
```

### 7.4 Bidirectional Control

**UI -> Agent (User controls agents):**

- Create tasks in the UI, assign to agents, click "Run"
- Pause/stop agents from the UI (send SIGINT to subprocess)
- Reassign tasks by dragging cards to different agent columns
- Set priority, which agents can read via list_tasks

**Agent -> UI (Agents control the board):**

- Create tasks/subtasks via MCP tools
- Update task status as work progresses
- Assign subtasks to other agent types
- Request agent spawning via spawn_agent tool

### 7.5 Real-Time Updates

```typescript
// WebSocket server in Agent Monitor backend
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 4101 });

// Event bus that MCP tool handlers and API routes emit to
import { EventEmitter } from 'events';
const eventBus = new EventEmitter();

eventBus.on('task:created', (task) => {
  broadcast({ type: 'TASK_CREATED', payload: task });
});

eventBus.on('task:updated', (task) => {
  broadcast({ type: 'TASK_UPDATED', payload: task });
});

eventBus.on('agent:spawned', (agent) => {
  broadcast({ type: 'AGENT_SPAWNED', payload: agent });
});

eventBus.on('agent:status', (agent) => {
  broadcast({ type: 'AGENT_STATUS', payload: agent });
});

function broadcast(message: object) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}
```

---

## 8. Comparison of Approaches

### 8.1 Integration Strategy Comparison

```
+---------------------------------------------------------------------+
|                    INTEGRATION APPROACHES                           |
+---------------------------------------------------------------------+
|                                                                     |
|  Approach 1: MCP Server (Recommended Primary)                      |
|  ============================================                       |
|  Pros:                                                              |
|  + Structured tool schema with validation                           |
|  + Auto-discovery by all 3 CLI agents                               |
|  + Type-safe (zod schemas)                                          |
|  + Low token cost (tool calls, not curl syntax)                     |
|  + Works with Claude Agent SDK programmatic spawning                |
|  + Teammates inherit MCP servers automatically                      |
|  Cons:                                                              |
|  - Requires MCP config per CLI                                      |
|  - More setup than plain REST                                       |
|  - Must maintain the MCP server code                                |
|                                                                     |
|  Approach 2: REST API via Bash (Fallback)                           |
|  ========================================                           |
|  Pros:                                                              |
|  + Works with ANY agent (even those without MCP)                    |
|  + Simple to implement (just API endpoints)                         |
|  + Already needed for the web UI                                    |
|  Cons:                                                              |
|  - Agents need prompt instructions for API usage                    |
|  - Higher token cost (curl syntax in context)                       |
|  - No input validation at agent level                               |
|  - Less reliable (agent may malform curl commands)                  |
|                                                                     |
|  Approach 3: Claude Teams (Native Coordination)                     |
|  ==============================================                     |
|  Pros:                                                              |
|  + Native task list with dependencies                               |
|  + Built-in messaging between agents                                |
|  + File-locking for race condition prevention                       |
|  + Integrated with Claude Code's UI                                 |
|  Cons:                                                              |
|  - Claude-only (no Codex/Gemini integration)                        |
|  - No external API/UI access to team state                          |
|  - Experimental feature with known limitations                      |
|  - Teams stored as local files only                                 |
|  - Cannot participate from external systems                         |
|                                                                     |
|  Approach 4: Hooks Bridge (Sync Claude Teams <-> Agent Monitor)     |
|  =============================================================     |
|  Pros:                                                              |
|  + Bridges Claude's native teams with external board                |
|  + Uses TaskCompleted and TeammateIdle hooks                        |
|  Cons:                                                              |
|  - One-way sync (Claude -> Agent Monitor, not bidirectional)        |
|  - Requires custom hook scripts                                     |
|  - Still limited to Claude ecosystem                                |
|                                                                     |
+---------------------------------------------------------------------+
```

### 8.2 Recommendation

**Use a layered approach:**

```
Layer 1 (Core):     Agent Monitor REST API
                    - Required for web UI anyway
                    - Database-backed task persistence
                    - WebSocket for real-time updates

Layer 2 (Primary):  Agent Monitor MCP Server
                    - Wraps Layer 1 REST API
                    - Structured tool interface for agents
                    - Configure in .mcp.json for auto-loading

Layer 3 (Fallback): CLAUDE.md / Prompt Instructions
                    - curl commands as fallback
                    - For agents that cannot use MCP

Layer 4 (Optional): Claude Hooks Bridge
                    - Sync Claude's native team tasks
                      to Agent Monitor's board
                    - TaskCompleted -> POST /api/tasks/sync
```

### 8.3 Implementation Priority

| Priority | Component                      | Effort  | Impact   |
| :------- | :----------------------------- | :------ | :------- |
| P0       | REST API for task CRUD         | 1 day   | Critical |
| P0       | Web UI (Kanban board)          | 2 days  | Critical |
| P1       | MCP Server (stdio)             | 1 day   | High     |
| P1       | Agent Spawner (Claude via SDK) | 1 day   | High     |
| P1       | WebSocket real-time updates    | 0.5 day | High     |
| P2       | MCP Server (HTTP transport)    | 0.5 day | Medium   |
| P2       | Agent Spawner (Codex, Gemini)  | 1 day   | Medium   |
| P2       | Loop prevention & depth limits | 0.5 day | Medium   |
| P3       | Claude Hooks bridge            | 1 day   | Low      |
| P3       | Team-level orchestration UI    | 2 days  | Low      |

---

## 9. Sources

### Claude Code Agent Teams

- [Orchestrate teams of Claude Code sessions (Official Docs)](https://code.claude.com/docs/en/agent-teams)
- [From Tasks to Swarms: Agent Teams in Claude Code](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/)
- [Claude Code Swarms - Addy Osmani](https://addyosmani.com/blog/claude-code-agent-teams/)
- [Claude Code Swarm Orchestration Skill (GitHub Gist)](https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea)
- [Claude Code's Hidden Multi-Agent System](https://paddo.dev/blog/claude-code-hidden-swarm/)
- [Claude Code Agent Teams: Multi-Session Orchestration](https://claudefa.st/blog/guide/agents/agent-teams)
- [Agent Teams with Claude Code and Claude Agent SDK (Medium)](https://kargarisaac.medium.com/agent-teams-with-claude-code-and-claude-agent-sdk-e7de4e0cb03e)
- [Claude 4.6 Agent Teams Complete Guide](https://blog.laozhang.ai/en/posts/claude-4-6-agent-teams)

### Claude Agent SDK

- [Agent SDK Overview (Official)](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Subagents in the SDK (Official)](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [Connect to external tools with MCP (Official)](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [Agent SDK TypeScript Reference (Official)](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Building Agents with the Claude Agent SDK (Anthropic Engineering)](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [The Definitive Guide to Claude Agent SDK (Medium)](https://datapoetica.medium.com/the-definitive-guide-to-the-claude-agent-sdk-building-the-next-generation-of-ai-69fda0a0530f)
- [Claude Agent SDK Cheatsheet](https://agnt.gg/articles/claude-agent-sdk-cheatsheet)
- [Claude Code Custom Subagents (Official)](https://code.claude.com/docs/en/sub-agents)

### MCP Protocol & SDK

- [Model Context Protocol TypeScript SDK (GitHub)](https://github.com/modelcontextprotocol/typescript-sdk)
- [TypeScript SDK Server Documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [@modelcontextprotocol/sdk (npm)](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP SDKs Overview](https://modelcontextprotocol.io/docs/sdk)
- [Build an MCP Server (Official Tutorial)](https://modelcontextprotocol.io/docs/develop/build-server)

### Claude Code MCP Configuration

- [Connect Claude Code to tools via MCP (Official)](https://code.claude.com/docs/en/mcp)
- [How to Setup Claude Code MCP Servers](https://claudelog.com/faqs/how-to-setup-claude-code-mcp-servers/)
- [Configuring MCP Tools in Claude Code](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code)

### Gemini CLI MCP

- [MCP Servers with the Gemini CLI (Official)](https://geminicli.com/docs/tools/mcp-server/)
- [Gemini CLI MCP Server Setup Guide](https://www.braingrid.ai/blog/gemini-mcp)

### Codex CLI MCP

- [Codex CLI MCP (Official)](https://developers.openai.com/codex/mcp)
- [Codex CLI Config Documentation (GitHub)](https://github.com/openai/codex/blob/main/docs/config.md)
- [Codex MCP Configuration TOML Guide](https://vladimirsiedykh.com/blog/codex-mcp-config-toml-shared-configuration-cli-vscode-setup-2025)

### Multi-Agent Frameworks

- [CrewAI Framework](https://www.crewai.com/)
- [CrewAI Documentation - Agents](https://docs.crewai.com/en/concepts/agents)
- [CrewAI Hierarchical Process](https://docs.crewai.com/how-to/hierarchical-process)
- [LangGraph Multi-Agent Orchestration Guide](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025)
- [LangGraph State Management 2025](https://sparkco.ai/blog/mastering-langgraph-state-management-in-2025)
- [AI Agent Orchestration Frameworks (n8n Blog)](https://blog.n8n.io/ai-agent-orchestration-frameworks/)
- [CrewAI vs LangGraph vs AutoGen (DataCamp)](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)

### Task Management for AI Agents

- [AgentsBoard (GitHub)](https://github.com/Justmalhar/AgentsBoard)
- [Claude-Flow (GitHub)](https://github.com/ruvnet/claude-flow)
- [Port: Automatically Resolve Tickets with Coding Agents](https://docs.port.io/guides/all/automatically-resolve-tickets-with-coding-agents/)

### Loop Prevention & Concurrency

- [AI Agent Design Patterns (Microsoft)](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [10 Multi-Agent Coordination Strategies (Galileo)](https://galileo.ai/blog/multi-agent-coordination-strategies)
- [Preventing Infinite Loops in Autonomous Agent Deployments](https://codieshub.com/for-ai/prevent-agent-loops-costs)
- [Concurrent Agent Orchestration (Microsoft)](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/concurrent)

### Claude Code Hooks

- [Hooks Reference (Official)](https://code.claude.com/docs/en/hooks)
- [Claude Code Hooks (Agent SDK)](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [Claude Code Hooks Mastery (GitHub)](https://github.com/disler/claude-code-hooks-mastery)
- [Claude Code Hooks Multi-Agent Observability (GitHub)](https://github.com/disler/claude-code-hooks-multi-agent-observability)
