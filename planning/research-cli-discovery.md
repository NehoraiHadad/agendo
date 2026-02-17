# Research: CLI Tool Discovery and Understanding for Agent Monitor

**Date:** 2026-02-17
**Purpose:** Practical patterns for programmatically discovering, registering, and understanding CLI tools

---

## Table of Contents

1. [MCP (Model Context Protocol) for Tool Discovery](#1-mcp-model-context-protocol-for-tool-discovery)
2. [CLI Help Parsing - Existing Tools and Libraries](#2-cli-help-parsing---existing-tools-and-libraries)
3. [How Orchestration Tools Handle Discovery](#3-how-orchestration-tools-handle-discovery)
4. [AI-Powered CLI Understanding](#4-ai-powered-cli-understanding)
5. [Bridge Between Web UI and Terminal Tools](#5-bridge-between-web-ui-and-terminal-tools)
6. [Successful Open-Source Projects in This Space](#6-successful-open-source-projects-in-this-space)
7. [Recommended Architecture for Agent Monitor](#7-recommended-architecture-for-agent-monitor)

---

## 1. MCP (Model Context Protocol) for Tool Discovery

### What MCP Is

MCP is an open protocol by Anthropic (released Nov 2024) that standardizes how AI/LLM applications integrate with external tools, data sources, and services. It uses JSON-RPC 2.0 messages between **hosts** (LLM apps), **clients** (connectors within hosts), and **servers** (services providing tools/resources).

- **Spec (latest stable):** https://modelcontextprotocol.io/specification/2025-11-25
- **TypeScript SDK:** https://github.com/modelcontextprotocol/typescript-sdk
- **npm:** `@modelcontextprotocol/sdk`

### How Tool Discovery Works

An MCP client discovers tools via the `tools/list` JSON-RPC method:

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": { "cursor": "optional-cursor-value" }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "get_weather",
        "title": "Weather Information Provider",
        "description": "Get current weather information for a location",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name or zip code"
            }
          },
          "required": ["location"]
        },
        "outputSchema": { ... },
        "annotations": { ... }
      }
    ],
    "nextCursor": "next-page-cursor"
  }
}
```

### Tool Schema (What Agent Monitor Should Adopt)

Each MCP tool has:

- **`name`**: Unique identifier (e.g., `"get_weather"`)
- **`title`**: Human-readable display name
- **`description`**: What the tool does (critical for LLM selection)
- **`inputSchema`**: JSON Schema for parameters
- **`outputSchema`**: Optional JSON Schema for structured results
- **`annotations`**: Behavioral hints (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)

**Key insight:** This schema format is exactly what Agent Monitor's `args_schema` should look like. MCP's tool schema IS the industry standard for describing tool capabilities to AI agents.

### MCP Server Discovery Mechanisms

**Current (stdio-based, local):**
Clients configure servers in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/path/to/server/build/index.js"]
    }
  }
}
```

**Emerging (well-known URLs):**
Servers can publish `/.well-known/mcp/server.json` for automatic discovery. The MCP Registry (https://registry.modelcontextprotocol.io/) is a centralized catalog with ~2000 servers.

**Network/HTTP-based:**
MCP supports Streamable HTTP transport for remote servers, not just stdio.

### Could Agent Monitor Act as an MCP Client?

**YES - this is a high-value approach.** Using `@modelcontextprotocol/sdk`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Connect to any MCP server
const transport = new StdioClientTransport({
  command: 'node',
  args: ['/path/to/mcp-server.js'],
});

const client = new Client({ name: 'agent-monitor', version: '1.0.0' });
await client.connect(transport);

// Discover all tools
const tools = await client.listTools();
// tools.tools => Array of { name, description, inputSchema, ... }

// Call a tool
const result = await client.callTool({
  name: 'get_weather',
  arguments: { location: 'New York' },
});
```

**Practical value for Agent Monitor:**

- Instantly discover ALL tools from any MCP server (Claude, Cursor, VS Code, etc.)
- Get structured schemas (inputSchema/outputSchema) with zero parsing effort
- Dynamic updates via `notifications/tools/list_changed`
- Access the growing MCP Registry ecosystem

### MCP Server Registration Pattern (TypeScript)

For Agent Monitor to EXPOSE its tools as MCP, here is the pattern:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'agent-monitor', version: '1.0.0' });

server.registerTool(
  'run_git_status',
  {
    description: 'Run git status in a repository',
    inputSchema: {
      repoPath: z.string().describe('Path to the git repository'),
    },
  },
  async ({ repoPath }) => {
    // Execute git status using safe process execution
    return { content: [{ type: 'text', text: result }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 2. CLI Help Parsing - Existing Tools and Libraries

### The Docopt Approach (Reverse-Engineer Help Text)

**Docopt** (http://docopt.org/) is the closest thing to "parse --help output into structured data." It works by taking a help/usage text string and extracting the CLI interface definition from it.

**How it works:**

- Parses text between `usage:` and the next blank line as usage patterns
- Extracts options with short/long forms (`-h`, `--help`)
- Identifies arguments (`<filename>`), optional elements (`[options]`), required elements
- Returns a map of option names to parsed values

**Available in:** Python, Go, Ruby, PHP, Haskell, Nim, C++, JavaScript

**Limitation for Agent Monitor:** Docopt expects the help text to follow docopt conventions. Real-world `--help` output varies wildly. It is a parser for well-formatted help text, not an arbitrary text extractor.

### jc - CLI Output to JSON (Highly Relevant)

**jc** (https://kellyjonbrazil.github.io/jc/) converts the **output** of 200+ CLI commands to structured JSON.

```bash
# Pipe any command output through jc
git log --oneline | jc --git-log
docker ps | jc --docker-ps
ls -la | jc --ls
```

**Supported parsers include:** ls, ps, netstat, ifconfig, df, du, mount, dig, ping, traceroute, arp, route, /etc/passwd, /etc/hosts, CSV, JSON, XML, YAML, TOML, git logs, docker commands, aws utilities, package managers.

**Architecture:**

- Standard parsers load complete input, streaming parsers process line-by-line
- Each parser (`jc/parsers/foo.py`) follows a template
- Custom plugins can be added to platform-specific directories
- Available as Python library: `jc.parse('dig', cmd_output)` returns dicts

**Value for Agent Monitor:** Use jc to parse CLI **output** into structured data. This is complementary to parsing --help (which gives you the interface) -- jc gives you the results.

### Node.js CLI Argument Libraries

These build CLIs but could inform schema extraction:

| Library               | npm                 | Key Feature                                                                              |
| --------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| **commander**         | `commander`         | Most popular. Auto-generates help. Option definitions include type, description, default |
| **yargs**             | `yargs`             | Rich option definition. Commands, grouped options, validation                            |
| **oclif**             | `oclif`             | Salesforce's framework. Plugins, flags, auto-documentation                               |
| **command-line-args** | `command-line-args` | Declarative option definitions (name, alias, type, multiple, defaultOption)              |
| **zod**               | `zod`               | Schema validation that can generate JSON Schema (used by MCP SDK)                        |

**None of these parse arbitrary --help output.** They are for building CLIs, not reverse-engineering them.

### Node.js Built-in

`util.parseArgs()` (stable since Node.js 20) parses arguments but requires predefined option config.

### tldr-pages, navi, cheat.sh (Command Databases)

These are community-maintained databases of CLI command examples:

**tldr-pages** (https://github.com/tldr-pages/tldr):

- Markdown files with simplified command examples
- Community-maintained for thousands of commands
- Format: `# command-name` + description + example blocks
- Could be used as a seed database for Agent Monitor's tool descriptions

**navi** (https://github.com/denisidoro/navi):

- Interactive cheatsheet tool using `.cheat` files
- Lines starting with `%` = tags, `#` = descriptions, `$` = argument value generators
- Uses fzf for interactive selection
- The `.cheat` format is a structured way to describe commands and their arguments

**cheat.sh** (https://cheat.sh):

- Aggregates multiple sources (including tldr-pages) into unified API
- Accessible via `curl cheat.sh/git-commit`
- Has a REST API that could be queried programmatically

**Value for Agent Monitor:** Use tldr-pages as a seed database for common CLI tool descriptions. The structured markdown format could be parsed to bootstrap tool registrations.

---

## 3. How Orchestration Tools Handle Discovery

### n8n - Package.json Scanning Pattern

**Source:** https://github.com/n8n-io/n8n/blob/main/packages/cli/src/LoadNodesAndCredentials.ts

n8n's node discovery architecture:

1. **Naming Convention:** Scans for packages matching `n8n-nodes-*` in node_modules
2. **Package.json metadata:** Looks for an `n8n` property:
   ```json
   {
     "n8n": {
       "nodes": ["dist/nodes/MyNode.node.js"],
       "credentials": ["dist/credentials/MyCredential.credentials.js"]
     }
   }
   ```
3. **Glob scanning:** Uses `*.node.js` and `*.credentials.js` patterns
4. **Dynamic instantiation:** Requires modules, instantiates classes, extracts `description` objects
5. **Registry construction:** Namespaces nodes as `packageName.nodeName`
6. **Hot-reloading:** Separation of discovery from execution enables reload

**Metadata extracted per node:**

- Fully qualified name
- Description object (display info, properties, operations)
- Icon paths (resolved to absolute paths)
- Source file location
- Type information (INodeType, ICredentialType)

**Pattern applicable to Agent Monitor:** A similar scanning approach could discover installed tool adapters. Agent Monitor could define a convention like `agent-monitor-tool-*` packages with standardized metadata in package.json.

### Raycast - Manifest-Based Discovery

**Source:** https://developers.raycast.com/information/manifest

Raycast extensions are npm packages with extended `package.json`:

```json
{
  "name": "my-extension",
  "title": "My Extension",
  "description": "What it does",
  "icon": "icon.png",
  "author": "username",
  "commands": [
    {
      "name": "index",
      "title": "Run Command",
      "description": "What this command does",
      "mode": "view",
      "arguments": [
        {
          "name": "query",
          "type": "text",
          "placeholder": "Search...",
          "required": true
        }
      ],
      "preferences": [
        {
          "name": "apiKey",
          "title": "API Key",
          "type": "password",
          "required": true
        }
      ],
      "keywords": ["search", "find"]
    }
  ]
}
```

**Key patterns:**

- `name` maps directly to entry point file (`src/index.ts`)
- `mode`: "view" (shows UI), "no-view" (API/URL), "menu-bar"
- `arguments`: Typed, with placeholders and required flags
- `preferences`: Configuration that persists across invocations
- `keywords`: For search/discovery within the app

**Applicable to Agent Monitor:** The Raycast manifest is an excellent model for Agent Monitor's tool registration format -- commands as an array with typed arguments and metadata.

### Zapier - Developer Platform Architecture

**Source:** https://docs.zapier.com/platform/

Zapier integrations:

1. **API-first:** Apps must have REST or XML-RPC APIs
2. **Two development paths:** Platform UI (visual builder) or Platform CLI (code)
3. **App discovery:** Zap Templates are pre-built integration patterns
4. **Publication pipeline:** Private -> Public Beta (90 days) -> Public
5. **Now supports MCP:** https://zapier.com/mcp -- connecting 8000+ apps to AI tools

**Key insight:** Zapier succeeded by making integration authoring accessible (visual builder + CLI). Agent Monitor should consider both manual registration AND an admin UI for non-developers.

### Temporal - Activity Registration via Workers

**Source:** https://docs.temporal.io/

Temporal's pattern:

1. **Workers register activities at startup** by creating in-memory mappings between function names and implementations
2. **Task queues** route work to workers via long-polling
3. **Centralized state** in Temporal Service tracks workflow and activity progress
4. **Separation of concerns:** Orchestrator (coordinator) vs. Workers (executors)

**Pattern applicable to Agent Monitor:** The worker-registration model maps well. CLI tools would be "activities" registered with "workers," and the Agent Monitor would be the orchestrator dispatching tasks to appropriate workers.

### Warp Terminal - AI-Powered CLI Understanding

**Source:** https://www.warp.dev/warp-ai

How Warp understands CLIs:

- Uses foundation models from Anthropic, OpenAI, and Google
- Routes different tasks to different models (coding, diff application, predictions)
- AI command suggestions generated as you type, returning multiple results
- Built in Rust for performance
- Privacy: terminal I/O never stored on Warp servers, passed directly to LLM APIs

**Key architectural insight:** Warp does NOT pre-parse every CLI. It uses LLMs in real-time to understand commands contextually. This validates Agent Monitor's planned "LLM enrichment" approach -- you do not need perfect parsing, you need good-enough context for an LLM to understand the tool.

---

## 4. AI-Powered CLI Understanding

### Strategy: LLM + --help = Structured Schema

The most practical approach for Agent Monitor:

1. **Capture --help output** using safe process execution (execFile, not exec)
2. **Send to LLM with structured output** and ask for JSON Schema
3. **Cache the result** (help text rarely changes between tool versions)

**Prompt pattern for LLM enrichment:**

```
Given this CLI help text, generate a JSON tool definition with:
- name, description, subcommands array
- Each subcommand: name, description, flags array
- Each flag: long name, short alias, description, takes value (bool), required (bool)

Help text:
<paste --help output here>
```

Use Claude or Gemini with structured output / tool_use to get validated JSON back.

### OpenAI Agents SDK - Automatic Schema Generation

The OpenAI Agents SDK generates function schemas automatically from Python function signatures + docstrings:

```python
from agents import tool

@tool
def search_files(query: str, path: str = ".") -> str:
    """Search for files matching a query.

    Args:
        query: The search pattern to match
        path: Directory to search in (default: current directory)
    """
    ...
# Schema auto-generated from type hints + docstring
```

**Key utilities:**

- `generate_func_documentation()` - extracts metadata from docstrings
- `function_schema()` - generates JSON Schema from function signature

**Applicable pattern:** Agent Monitor could use a similar decorator approach for registering tool adapters.

### Vercel AI SDK - Tool Definition Pattern

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const weatherTool = tool({
  description: 'Get the weather in a location',
  parameters: z.object({
    location: z.string().describe('The location to get weather for'),
  }),
  execute: async ({ location }) => {
    return { temperature: 72, conditions: 'Sunny' };
  },
});
```

### Open Agentic Schema Framework (OASF)

**Source:** https://github.com/agntcy/oasf

OASF provides an MCP Server that can automatically generate complete OASF records from codebases. This is a framework for describing agent capabilities in a standardized way.

---

## 5. Bridge Between Web UI and Terminal Tools

### The Standard Pattern: node-pty + xterm.js + WebSocket

This is the dominant architecture used by VS Code, Wetty, ttyd, GoTTY, and most web-based terminals:

```
Browser (xterm.js) <--WebSocket--> Server (node-pty) <--PTY--> Shell/Process
```

**node-pty** (https://github.com/microsoft/node-pty):

- Forks pseudoterminals in Node.js
- Returns terminal object with read/write
- Cross-platform (Linux, macOS, Windows via conpty)

**xterm.js** (https://www.npmjs.com/package/xterm):

- JavaScript terminal emulator for browsers
- Full terminal capabilities (colors, cursor, scrollback)
- Addons: WebGL renderer, search, fit, web links

**Basic web terminal architecture:**

```
Server side:
  1. Create WebSocket server
  2. On connection, spawn shell via pty.spawn('bash', ...)
  3. Relay: shell.onData -> ws.send, ws.onMessage -> shell.write
  4. On ws close, kill shell

Client side:
  1. Create xterm.Terminal instance
  2. Connect to WebSocket
  3. Relay: terminal.onData -> ws.send, ws.onMessage -> terminal.write
```

### VS Code Shell Integration

VS Code injects custom escape sequences into shell sessions to enable:

- **Working directory detection** (knows which directory you are in)
- **Command detection** (knows when a command starts/ends and its exit code)
- **Command decorations** (success/failure indicators in the gutter)
- **Command navigation** (jump between commands)

Quality levels: None, Basic, Rich (full command detection).

Extension API: `Terminal.shellIntegration` gives programmatic access.

**Key insight for Agent Monitor:** VS Code does NOT parse --help. Instead, it uses shell integration escape sequences to understand the terminal session. Agent Monitor could adopt a similar approach -- inject a shell wrapper that reports command boundaries, exit codes, and working directories.

### Web Terminal Projects

| Project   | Language          | Transport           | Frontend       |
| --------- | ----------------- | ------------------- | -------------- |
| **ttyd**  | C (libwebsockets) | WebSocket           | xterm.js       |
| **GoTTY** | Go                | WebSocket           | xterm.js/hterm |
| **Wetty** | Node.js           | WebSocket/Socket.IO | xterm.js       |

All follow the same pattern: websocket relay between browser terminal emulator and server-side PTY.

### Better Pattern Than spawn + pipe?

For Agent Monitor's use case (executing CLI commands programmatically, not providing a full interactive terminal), the simpler pattern is preferred:

**Non-interactive commands (git status, docker ps, npm list):**
Use `execa` or Node.js `execFile` (NOT `exec` to avoid shell injection). Capture stdout, stderr, exit code. This is sufficient for 90% of Agent Monitor's use cases.

**Interactive commands (requiring stdin, TTY):**
Use `node-pty` to spawn a pseudo-terminal. This handles prompts, password inputs, progress bars, etc.

**Recommendation:** Start with `execFile`/`execa` for everything. Add `node-pty` only when specific tools require interactive terminal behavior.

---

## 6. Successful Open-Source Projects in This Space

### AI Agent Frameworks - Tool Registration Patterns

#### CrewAI (Python)

**Source:** https://docs.crewai.com/en/learn/create-custom-tools

Two patterns for tool registration:

**Pattern 1: BaseTool class**

```python
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

class GitStatusInput(BaseModel):
    repo_path: str = Field(..., description="Path to git repository")

class GitStatusTool(BaseTool):
    name: str = "git_status"
    description: str = "Get the current git status of a repository"
    args_schema: Type[BaseModel] = GitStatusInput

    def _run(self, repo_path: str) -> str:
        # execute git status safely
        ...
```

**Pattern 2: @tool decorator**

```python
from crewai.tools import tool

@tool("git_status")
def git_status(repo_path: str) -> str:
    """Get the current git status of a repository."""
    ...
```

**Key insight:** CrewAI uses a **shared tool registry** -- tools defined once, accessible to all agents. This is the right model for Agent Monitor.

#### LangGraph (TypeScript/Python)

Tools are wrapped as graph nodes and bound to models:

```typescript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const gitStatusTool = tool(
  async ({ repoPath }) => {
    // execute git status safely
  },
  {
    name: 'git_status',
    description: 'Get git status for a repository',
    schema: z.object({
      repoPath: z.string().describe('Path to git repository'),
    }),
  },
);

// Bind tools to model
const modelWithTools = model.bindTools([gitStatusTool]);

// Create tool node for graph
const toolNode = new ToolNode([gitStatusTool]);
```

**Key insight:** LangGraph uses Zod schemas for tool definitions -- the same approach as the MCP TypeScript SDK. This validates using Zod for Agent Monitor's schema definitions.

#### AutoGen

Registers tools per agent. Each agent has its own tool set rather than a shared registry.

### Rundeck - CLI Wrapper with Web UI

**Source:** https://github.com/rundeck/rundeck

Rundeck is the closest existing open-source project to what Agent Monitor is doing for CLI tools:

- Web console + CLI + WebAPI
- Runs tasks on any number of nodes from web interface
- Self-service operations: give specific users access to existing tools/scripts
- Access control, audit logging, scheduled jobs

**Key architectural pattern:** "Job" definitions wrap CLI commands with metadata (description, options, node selection, scheduling). This is essentially "tool registration for DevOps."

### Other Notable Projects

| Project       | What it does                 | Relevance                                                   |
| ------------- | ---------------------------- | ----------------------------------------------------------- |
| **Spacelift** | IaC automation with web UI   | Wraps terraform/pulumi/ansible with policy, approval, audit |
| **Rundeck**   | Runbook automation           | CLI wrapper with web UI, closest to Agent Monitor concept   |
| **n8n**       | Workflow automation          | 350+ node integrations, package.json discovery pattern      |
| **OpenCode**  | AI coding agent for terminal | Tool registration with Zod schemas, agent config in YAML    |

---

## 7. Recommended Architecture for Agent Monitor

### Tool Registration Schema (Based on Research)

Synthesizing all findings, here is the recommended tool definition format that aligns with MCP, CrewAI, LangGraph, and Raycast patterns:

```typescript
import { z } from 'zod';

// Core tool definition schema (MCP-compatible)
const ToolDefinition = z.object({
  // Identity
  name: z.string(), // "git" or "git.commit"
  title: z.string(), // "Git Version Control"
  description: z.string(), // For LLM understanding
  version: z.string().optional(),

  // Classification
  category: z.enum(['vcs', 'container', 'package', 'ai', 'devops', 'system']),
  tags: z.array(z.string()),

  // Capabilities
  subcommands: z.array(
    z.object({
      name: z.string(), // "commit"
      description: z.string(),
      inputSchema: z.record(z.any()), // JSON Schema for arguments
      outputSchema: z.record(z.any()).optional(),
      annotations: z
        .object({
          readOnly: z.boolean().default(false),
          destructive: z.boolean().default(false),
          idempotent: z.boolean().default(false),
          requiresConfirmation: z.boolean().default(false),
        })
        .optional(),
    }),
  ),

  // Execution
  binary: z.string(), // "git", "/usr/bin/docker"
  requiresAuth: z.boolean().default(false),

  // Discovery metadata
  discoveredVia: z.enum(['manual', 'mcp', 'help-parse', 'llm-enrichment', 'package-scan']),
  discoveredAt: z.string().datetime(),
  lastVerified: z.string().datetime().optional(),
});
```

### Discovery Pipeline (Phased)

#### Phase 1: MVP - Manual Registration + Seed Database

```
1. Hand-write definitions for core tools (git, docker, npm, claude, gemini)
2. Use tldr-pages as seed data for descriptions
3. Store in JSON/YAML files
```

#### Phase 2: --help Parsing + LLM Enrichment

```
1. Run `<tool> --help` and capture output (using execFile, not exec)
2. Send help text to Claude/Gemini with structured output schema
3. LLM returns parsed tool definition
4. Human reviews and approves
5. Cache result (help text rarely changes)
```

#### Phase 3: MCP Integration

```
1. Act as MCP client to discover tools from MCP servers
2. Import tools from MCP Registry API
3. Expose Agent Monitor's own tools as MCP server
4. Support .well-known/mcp discovery
```

#### Phase 4: Auto-Discovery

```
1. Scan PATH for known binaries
2. Scan package.json for agent-monitor-tool-* packages (n8n pattern)
3. Watch for new MCP server registrations
4. Periodic re-verification of tool availability
```

### Practical Libraries to Use

| Purpose                | Library                     | npm/Link                                                |
| ---------------------- | --------------------------- | ------------------------------------------------------- |
| Tool schema validation | `zod`                       | Standard in MCP + LangGraph ecosystem                   |
| MCP client/server      | `@modelcontextprotocol/sdk` | Official SDK                                            |
| Process execution      | `execa`                     | Modern child_process wrapper (uses execFile internally) |
| CLI output parsing     | `jc` (Python) or custom     | For parsing tool outputs                                |
| Terminal emulation     | `node-pty` + `xterm.js`     | For interactive commands only                           |
| WebSocket              | `ws`                        | For terminal relay                                      |
| Command database       | tldr-pages                  | Seed descriptions                                       |

### Code Pattern: Tool Adapter

```typescript
// tool-adapter.ts - The adapter pattern for wrapping CLI tools

import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ToolAdapter {
  name: string;
  description: string;
  // Discover what this tool can do
  discover(): Promise<ToolDefinition>;
  // Execute a subcommand
  execute(subcommand: string, args: Record<string, unknown>): Promise<ExecutionResult>;
  // Check if the tool is available
  isAvailable(): Promise<boolean>;
}

class GitAdapter implements ToolAdapter {
  name = 'git';
  description = 'Distributed version control system';

  async discover(): Promise<ToolDefinition> {
    const { stdout: helpText } = await execFileAsync('git', ['--help']);
    const { stdout: version } = await execFileAsync('git', ['--version']);
    // Parse or use LLM to extract structured definition
    return parseHelpToSchema(helpText, version);
  }

  async execute(subcommand: string, args: Record<string, unknown>) {
    const cliArgs = buildArgs(subcommand, args);
    const { stdout, stderr } = await execFileAsync('git', cliArgs);
    return { stdout, stderr, exitCode: 0 };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('git', ['--version']);
      return true;
    } catch {
      return false;
    }
  }
}
```

### MCP Integration Pattern

```typescript
// mcp-bridge.ts - Bridge between Agent Monitor and MCP ecosystem

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

class MCPBridge {
  private clients: Map<string, Client> = new Map();

  // Connect to an MCP server and discover its tools
  async connectServer(name: string, command: string, args: string[]) {
    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name: 'agent-monitor', version: '1.0.0' });
    await client.connect(transport);

    // Discover all tools
    const { tools } = await client.listTools();

    // Convert MCP tools to Agent Monitor tool definitions
    for (const mcpTool of tools) {
      await this.registerTool({
        name: `${name}.${mcpTool.name}`,
        title: mcpTool.title || mcpTool.name,
        description: mcpTool.description || '',
        inputSchema: mcpTool.inputSchema,
        outputSchema: mcpTool.outputSchema,
        discoveredVia: 'mcp',
        discoveredAt: new Date().toISOString(),
      });
    }

    this.clients.set(name, client);
  }

  // Execute a tool via MCP
  async executeTool(serverName: string, toolName: string, args: Record<string, unknown>) {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server ${serverName} not connected`);
    return client.callTool({ name: toolName, arguments: args });
  }
}
```

---

## Key Takeaways

1. **MCP is the standard.** Agent Monitor should adopt MCP's tool schema format (name, description, inputSchema, outputSchema, annotations) as its internal representation. This gives free interoperability with the growing MCP ecosystem.

2. **LLM enrichment is the practical path for --help parsing.** No library reliably parses arbitrary --help text. But sending help text to an LLM with a structured output schema works well. Cache aggressively.

3. **Hybrid discovery is best.** Manual registration for MVP, LLM-assisted --help parsing for expansion, MCP client for ecosystem integration, package.json scanning for plugin architecture.

4. **The n8n + Raycast patterns for plugin discovery** (package.json metadata + manifest conventions) are battle-tested and should be adopted for Agent Monitor's plugin architecture.

5. **For execution, safe process spawning is fine.** Use `execa` or `execFile` (never `exec`) for non-interactive commands, `node-pty` only for interactive ones. The xterm.js + WebSocket pattern is only needed if Agent Monitor provides a web terminal UI.

6. **Zod is the schema language.** Used by MCP SDK, LangGraph, Vercel AI SDK, and OpenCode. It generates JSON Schema, validates at runtime, and has excellent TypeScript integration.

7. **tldr-pages is a free seed database.** 50,000+ pages of structured CLI command documentation that can bootstrap Agent Monitor's tool knowledge.

---

## Sources

### MCP

- [MCP Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Build Server Tutorial](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP Registry](https://registry.modelcontextprotocol.io/)
- [MCP Well-Known Discovery Discussion](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1147)
- [MCP Roadmap](https://modelcontextprotocol.io/development/roadmap)

### CLI Parsing

- [docopt](http://docopt.org/)
- [jc - CLI to JSON](https://kellyjonbrazil.github.io/jc/)
- [tldr-pages](https://github.com/tldr-pages/tldr)
- [navi](https://github.com/denisidoro/navi)
- [cheat.sh](https://cheat.sh)
- [commander.js](https://www.npmjs.com/package/commander)
- [yargs](https://yargs.js.org/)

### Orchestration Tools

- [n8n Node System](https://deepwiki.com/n8n-io/n8n/4-user-interface)
- [n8n LoadNodesAndCredentials](https://github.com/n8n-io/n8n/blob/main/packages/cli/src/LoadNodesAndCredentials.ts)
- [n8n Creating Nodes](https://docs.n8n.io/integrations/creating-nodes/overview/)
- [Raycast Manifest](https://developers.raycast.com/information/manifest)
- [Raycast API Architecture](https://www.raycast.com/blog/how-raycast-api-extensions-work)
- [Temporal Architecture](https://github.com/temporalio/temporal/blob/main/docs/architecture/workflow-lifecycle.md)
- [Zapier Developer Platform](https://zapier.com/developer-platform)
- [Zapier MCP](https://zapier.com/mcp)

### AI Agent Frameworks

- [CrewAI Custom Tools](https://docs.crewai.com/en/learn/create-custom-tools)
- [LangGraph Tool Calling](https://langchain-ai.github.io/langgraph/how-tos/many-tools/)
- [AI Agent Framework Comparison](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
- [Vercel AI SDK Tools](https://ai-sdk.dev/docs/foundations/tools)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [OASF](https://github.com/agntcy/oasf)

### Terminal Integration

- [node-pty](https://github.com/microsoft/node-pty)
- [xterm.js](https://www.npmjs.com/package/xterm)
- [VS Code Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration)
- [ttyd](https://github.com/tsl0922/ttyd)
- [GoTTY](https://github.com/yudai/gotty)
- [Warp Terminal](https://www.warp.dev/)

### DevOps / CLI Wrappers

- [Rundeck](https://github.com/rundeck/rundeck)
- [OpenCode](https://github.com/opencode-ai/opencode)
