# CLI Tool Testing Research for Agent Monitor

**Date:** 2026-02-17
**Machine:** instance-neo (Oracle Cloud), Ubuntu, 4 CPU / 16GB RAM

---

## 1. Claude Code CLI

### Location & Version
```
$ which claude
/home/ubuntu/.local/bin/claude

$ claude --version
2.1.44 (Claude Code)
```

### Help Output (full)
```
Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Arguments:
  prompt                                            Your prompt

Options:
  --add-dir <directories...>                        Additional directories to allow tool access to
  --agent <agent>                                   Agent for the current session
  --agents <json>                                   JSON object defining custom agents
  --allow-dangerously-skip-permissions              Enable bypassing all permission checks as an option
  --allowedTools, --allowed-tools <tools...>        Comma or space-separated list of tool names to allow
  --append-system-prompt <prompt>                   Append a system prompt to the default system prompt
  --betas <betas...>                                Beta headers to include in API requests
  --chrome                                          Enable Claude in Chrome integration
  -c, --continue                                    Continue the most recent conversation in the current directory
  --dangerously-skip-permissions                    Bypass all permission checks
  -d, --debug [filter]                              Enable debug mode with optional category filtering
  --debug-file <path>                               Write debug logs to a specific file path
  --disable-slash-commands                          Disable all skills
  --disallowedTools, --disallowed-tools <tools...>  Comma or space-separated list of tool names to deny
  --effort <level>                                  Effort level (low, medium, high)
  --fallback-model <model>                          Automatic fallback model when overloaded (--print only)
  --file <specs...>                                 File resources to download at startup
  --fork-session                                    When resuming, create a new session ID (use with --resume or --continue)
  --from-pr [value]                                 Resume a session linked to a PR
  -h, --help                                        Display help for command
  --ide                                             Auto-connect to IDE on startup
  --include-partial-messages                        Include partial message chunks (--print + stream-json only)
  --input-format <format>                           Input format (--print only): "text" (default) or "stream-json"
  --json-schema <schema>                            JSON Schema for structured output validation
  --max-budget-usd <amount>                         Maximum dollar amount to spend (--print only)
  --mcp-config <configs...>                         Load MCP servers from JSON files or strings
  --model <model>                                   Model for the session (alias like 'sonnet' or full name)
  --no-chrome                                       Disable Claude in Chrome integration
  --no-session-persistence                          Disable session persistence (--print only)
  --output-format <format>                          Output format (--print only): "text", "json", "stream-json"
  --permission-mode <mode>                          Permission mode: acceptEdits, bypassPermissions, default, delegate, dontAsk, plan
  --plugin-dir <paths...>                           Load plugins from directories
  -p, --print                                       Print response and exit (non-interactive)
  --replay-user-messages                            Re-emit user messages on stdout (stream-json bidirectional)
  -r, --resume [value]                              Resume a conversation by session ID, or open interactive picker
  --session-id <uuid>                               Use a specific session ID (must be valid UUID)
  --setting-sources <sources>                       Comma-separated list of setting sources to load
  --settings <file-or-json>                         Path to settings JSON file or JSON string
  --strict-mcp-config                               Only use MCP servers from --mcp-config
  --system-prompt <prompt>                          System prompt for the session
  --tools <tools...>                                Specify available tools from built-in set
  --verbose                                         Override verbose mode setting
  -v, --version                                     Output the version number

Commands:
  auth                                              Manage authentication
  doctor                                            Check health of auto-updater
  install [target]                                  Install Claude Code native build
  mcp                                               Configure and manage MCP servers
  plugin                                            Manage Claude Code plugins
  setup-token                                       Set up long-lived auth token
  update|upgrade                                    Check for updates and install
```

### Session Management Flags
| Flag | Behavior |
|------|----------|
| `-r, --resume [value]` | Resume by session UUID, or open interactive picker with search term |
| `-c, --continue` | Continue the **most recent** conversation in the current directory |
| `--session-id <uuid>` | Force a specific session UUID |
| `--fork-session` | Create new session ID when resuming (use with --resume or --continue) |
| `--from-pr [value]` | Resume session linked to a PR |
| `--no-session-persistence` | Disable session saving (--print only) |

### Output Format Options
| Flag | Values | Notes |
|------|--------|-------|
| `-p, --print` | N/A | Non-interactive mode, required for output-format |
| `--output-format` | `text`, `json`, `stream-json` | Only works with `--print` |
| `--input-format` | `text`, `stream-json` | Only works with `--print` |
| `--include-partial-messages` | boolean | Only with `--print` + `stream-json` |
| `--verbose` | boolean | **Required** for `--output-format=stream-json` |

### Session ID in Output (CONFIRMED)

**`--output-format json` (single result):**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 2671,
  "duration_api_ms": 2288,
  "num_turns": 1,
  "result": "Hello! How can I help you today?",
  "stop_reason": null,
  "session_id": "d31fb225-418f-4f94-ab24-ed95cf77a036",    <-- SESSION ID
  "total_cost_usd": 0.22317750000000003,
  "usage": { ... },
  "modelUsage": { ... },
  "permission_denials": [],
  "uuid": "dbfa3eab-af51-497e-8cdf-db0addae3b96"           <-- message UUID
}
```

**`--output-format stream-json --verbose` (streaming):**
Emits multiple JSON lines:
1. `{"type":"system","subtype":"init","session_id":"...","tools":[...],"model":"claude-opus-4-6",...}`
2. `{"type":"assistant","message":{...},"session_id":"...",...}`
3. `{"type":"result","session_id":"...",...}`

**Key finding:** `session_id` is a UUID v4 (e.g., `d31fb225-418f-4f94-ab24-ed95cf77a036`). It appears in every message type in stream-json, and in the final result in json mode.

### Session Storage
```
~/.claude/projects/-home-ubuntu-projects/<uuid>.jsonl     # per-project session transcripts
~/.claude/sessions/                                        # session metadata (hash-named dirs)
~/.claude/history.jsonl                                    # global history (3.2MB)
~/.claude/session-env/                                     # session environment snapshots
```

**Session JSONL format (per line):**
```json
{
  "parentUuid": null,
  "sessionId": "5874974b-2b24-4b5b-bb1d-63a7abe930b7",
  "version": "2.1.29",
  "type": "user",
  "message": {"role":"user","content":"..."},
  "uuid": "1e486904-f371-4a5b-9248-093fcbe7e2b1",
  "timestamp": "2026-01-31T23:17:43.335Z",
  "cwd": "/home/ubuntu/projects"
}
```

---

## 2. Gemini CLI

### Location & Version
```
$ which gemini
/usr/bin/gemini

$ gemini --version
0.20.2
```

### Help Output (full)
```
Usage: gemini [options] [command]

Gemini CLI - Launch an interactive CLI, use -p/--prompt for non-interactive mode

Commands:
  gemini [query..]             Launch Gemini CLI  [default]
  gemini mcp                   Manage MCP servers
  gemini extensions <command>  Manage Gemini CLI extensions.

Positionals:
  query  Positional prompt. Defaults to one-shot; use -i/--prompt-interactive for interactive.

Options:
  -d, --debug                     Run in debug mode
  -m, --model                     Model
  -p, --prompt                    Prompt [DEPRECATED: use positional]
  -i, --prompt-interactive        Execute prompt and continue interactive
  -s, --sandbox                   Run in sandbox
  -y, --yolo                      Auto-accept all actions
      --approval-mode             default | auto_edit | yolo
      --experimental-acp          ACP mode
      --allowed-mcp-server-names  Allowed MCP server names
      --allowed-tools             Tools allowed without confirmation
  -e, --extensions                Extensions to use
  -l, --list-extensions           List all available extensions
  -r, --resume                    Resume previous session ("latest" or index number)
      --list-sessions             List available sessions and exit
      --delete-session            Delete session by index number
      --include-directories       Additional workspace directories
      --screen-reader             Screen reader mode
  -o, --output-format             text | json | stream-json
  -v, --version                   Show version
  -h, --help                      Show help
```

### Session Management Flags
| Flag | Behavior |
|------|----------|
| `-r, --resume` | Resume by "latest" or by index number (e.g., `--resume 5`) |
| `--list-sessions` | List sessions for current project, shows index + UUID |
| `--delete-session` | Delete by index number |

**Note:** Gemini uses **index-based** session resume, not direct UUID. Session listing output format:
```
  1. What is 2+2? (1 day ago) [02f8fc16-5412-4cb8-9dbb-c3c4ee3facfc]
  2. What is 2+2? (1 day ago) [38232b6d-9135-4823-a237-07624c77e3e4]
  ...
```
Format: `{index}. {title truncated} ({relative time}) [{session UUID}]`

### Output Format Options
| Flag | Values | Notes |
|------|--------|-------|
| `-o, --output-format` | `text`, `json`, `stream-json` | Works with positional prompt (non-interactive) |

### Session ID in Output (CONFIRMED -- ABSENT from JSON)

**`-o json` output:**
```json
{
  "response": "hello",
  "stats": {
    "models": {
      "gemini-2.5-flash-lite": {
        "api": { "totalRequests": 1, "totalErrors": 0, "totalLatencyMs": 2191 },
        "tokens": { "prompt": 2930, "candidates": 62, "total": 3100, "cached": 0, "thoughts": 108, "tool": 0 }
      },
      "gemini-2.5-flash": {
        "api": { "totalRequests": 1, "totalErrors": 0, "totalLatencyMs": 2594 },
        "tokens": { "prompt": 9804, "candidates": 1, "total": 9835, "cached": 9759, "thoughts": 30, "tool": 0 }
      }
    },
    "tools": { "totalCalls": 0, ... },
    "files": { "totalLinesAdded": 0, "totalLinesRemoved": 0 }
  }
}
```

**Key finding:** Gemini JSON output does **NOT** include a session ID. The session is only visible via `--list-sessions` after the fact. To get a session ID, you must parse the `--list-sessions` output and correlate by timestamp/title.

### Session Storage
```
~/.gemini/tmp/<project-hash>/chats/session-<date>-<short-uuid>.json
```

**Session JSON format:**
```json
{
  "sessionId": "93b60a72-9197-4237-b861-d4f042b7216c",
  "projectHash": "0ab97a27c1e72dc3e5ecec173de497c9e38256acaafa8f0bac0945f168ecb9a4",
  "startTime": "2025-10-16T12:41:25.239Z",
  "lastUpdated": "2025-10-16T12:41:58.348Z",
  "messages": [
    { "id": "...", "timestamp": "...", "type": "user|gemini", "content": "...", "thoughts": [...] }
  ]
}
```

---

## 3. Codex CLI

### Location & Version
```
$ ls ~/.bun/bin/codex
/home/ubuntu/.bun/bin/codex

$ codex --version
(no --version flag observed in help; version found in session files: 0.101.0)
```

### Help Output (full)
```
Codex CLI

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  exec        Run Codex non-interactively [aliases: e]
  review      Run a code review non-interactively
  login       Manage login
  logout      Remove stored authentication credentials
  mcp         [experimental] Run Codex as an MCP server
  mcp-server  [experimental] Run the Codex MCP server (stdio transport)
  app-server  [experimental] Run the app server
  completion  Generate shell completion scripts
  sandbox     Run commands within a Codex-provided sandbox
  debug       Debugging tools
  apply       Apply latest diff as git apply [aliases: a]
  resume      Resume a previous interactive session
  fork        Fork a previous interactive session
  cloud       [EXPERIMENTAL] Browse tasks from Codex Cloud
  features    Inspect feature flags
  help        Print this message

Options:
  -c, --config <key=value>                 Override config.toml values
  -i, --image <FILE>...                    Attach image(s) to initial prompt
  -m, --model <MODEL>                      Model the agent should use
      --oss                                Use local open source provider
      --local-provider <OSS_PROVIDER>      lmstudio or ollama
  -p, --profile <CONFIG_PROFILE>           Configuration profile from config.toml
  -s, --sandbox <SANDBOX_MODE>             read-only | workspace-write | danger-full-access
  -a, --ask-for-approval <APPROVAL_POLICY> untrusted | on-failure | on-request | never
      --full-auto                          Low-friction sandboxed auto execution
      --dangerously-bypass-approvals-and-sandbox   Skip all confirmation (DANGEROUS)
  -C, --cd <DIR>                           Agent working root
      --search                             Enable live web search
      --add-dir <DIR>                      Additional writable directories
```

### Session Management

**`codex resume --help`:**
```
Resume a previous interactive session

Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]  Conversation/session id (UUID) or thread name. UUIDs take precedence.
  [PROMPT]      Optional user prompt to start the session

Options:
  --last   Continue the most recent session without picker
  --all    Show all sessions (disables cwd filtering)
```

**`codex exec resume`** -- resumes in non-interactive mode.
**`codex fork`** -- creates a branch from an existing session.

### Output Format
Codex does **NOT** have `--output-format` or `--json` flags. It writes output as JSONL to session files. Non-interactive mode (`codex exec`) writes to stdout as plaintext by default.

### Session ID in Output
Session ID is embedded in the JSONL session filename:
```
~/.codex/sessions/2026/02/17/rollout-2026-02-17T07-27-38-019c6a7f-5f3f-7551-a009-73bd70581f24.jsonl
```
Format: `rollout-<ISO-date>-<uuid-v7>.jsonl`

**Session JSONL format (first line):**
```json
{
  "timestamp": "2026-02-17T07:27:38.338Z",
  "type": "session_meta",
  "payload": {
    "id": "019c6a7f-5f3f-7551-a009-73bd70581f24",
    "cwd": "/home/ubuntu/projects",
    "originator": "codex_exec",
    "cli_version": "0.101.0",
    "source": "exec",
    "model_provider": "openai"
  }
}
```

### Session Storage
```
~/.codex/sessions/<year>/<month>/<day>/rollout-<date>-<uuid>.jsonl
~/.codex/history.jsonl        # global history
~/.codex/config.toml          # configuration
```

---

## 4. Common CLI Tools

### Summary Table

| Tool | Version | Location | --help format | Structured? |
|------|---------|----------|---------------|-------------|
| git | 2.34.1 | /usr/bin/git | Categorized subcommands | Semi-structured (categories + descriptions) |
| docker | 28.4.0 | /usr/bin/docker | Categorized commands | Well-structured (Common/Management/Swarm/Commands) |
| npm | 11.7.0 | /usr/lib/node_modules/npm | Flat command list | Minimal structure |
| node | v22.20.0 | /usr/bin/node | Flat flag list | Flag-per-line, indented descriptions |
| python3 | 3.10.12 | /usr/bin/python3 | Flat flag list | Flag + inline description, freeform |

### Help Format Analysis

**git:**
- Usage line, then categorized sections ("start a working area", "examine the history", etc.)
- Each command: `   command     Description` (3-space indent, variable spacing)
- Parseable via regex: `/^\s{3}(\w+)\s{2,}(.+)$/`

**docker:**
- `Usage:  docker [OPTIONS] COMMAND`
- Sections: "Common Commands:", "Management Commands:", "Swarm Commands:", "Commands:"
- Each: `  command     Description` (2-space indent)
- Parseable, well-structured with clear section headers

**npm:**
- `npm <command>` then examples
- "All commands:" section with comma-separated list on multiple lines
- Less parseable for descriptions (need `npm <command> -h` per command)

**node:**
- `Usage: node [options] [ script.js ] [arguments]`
- Options section, each flag indented with description
- Classic Unix-style, parseable via regex

**python3:**
- `usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...`
- Flag + inline description, runs together
- Less structured, harder to parse

### Consistency Analysis
- All support `--version` and `--help`
- `--version` output varies: some print just version ("2.34.1"), some add prefix ("Python 3.10.12"), some add program name
- `--help` is universally freeform text, not machine-readable JSON/YAML
- No tool provides `--help --json` or structured help output

---

## 5. PATH Scanning

### PATH Directories (in order)
```
/home/ubuntu/.local/bin           (81 binaries)   -- claude, AI tools, python packages
/home/ubuntu/.bun/bin             (3 binaries)    -- bun, bunx, codex
/home/ubuntu/.local/share/pnpm    (9 binaries)    -- pnpm, pnpx, node tools, vercel
/usr/local/sbin                   (1 binary)
/usr/local/bin                    (7 binaries)    -- aws, ngrok, pip, sam
/usr/sbin                         (439 binaries)
/usr/bin                          (1266 binaries) -- gemini, git, docker, node, python3, etc.
/sbin                             (439 binaries)  -- symlinks to /usr/sbin
/bin                              (1266 binaries) -- symlinks to /usr/bin
/snap/bin                         (9 binaries)
```

### Notable Binaries in ~/.local/bin
```
claude           -- Claude Code CLI
cursor-agent     -- Cursor agent CLI
fastmcp          -- FastMCP (MCP server framework)
mcp              -- MCP CLI
openai           -- OpenAI CLI
playwright       -- Playwright browser automation
streamlit        -- Streamlit
tiny-agents      -- Hugging Face Tiny Agents
ai-designer      -- Custom AI tool
```

### Notable Binaries in ~/.bun/bin
```
bun
bunx
codex            -- Codex CLI (OpenAI)
```

### Auto-Discovery Strategy
1. **Scan PATH dirs** in order, list all executables
2. **Known AI CLIs** to check: `claude`, `gemini`, `codex`, `cursor-agent`, `openai`, `mcp`, `tiny-agents`, `adk` (Google ADK)
3. **Detection method**: `which <name>` or iterate PATH dirs
4. **Version detection**: `<tool> --version 2>&1` (universal pattern)
5. **Help parsing**: `<tool> --help 2>&1` then regex for flags/subcommands

---

## 6. Session Behavior Deep-Dive

### Claude Code Sessions
```
Config dir:    ~/.claude/
Session files: ~/.claude/projects/<project-path-slug>/<uuid>.jsonl
Session env:   ~/.claude/session-env/<uuid>/
History:       ~/.claude/history.jsonl
```

**Session ID format:** UUID v4 (e.g., `5874974b-2b24-4b5b-bb1d-63a7abe930b7`)

**How sessions are organized:**
- Project path is slugified (e.g., `/home/ubuntu/projects` -> `-home-ubuntu-projects`)
- Each session is a `.jsonl` file named by its UUID
- Some sessions also have a directory (same UUID) for associated data
- `history.jsonl` is a flat log of all sessions (3.2MB, growing)

**Resume mechanics:**
- `--resume <uuid>` resumes by UUID
- `--resume` (no arg) opens interactive picker
- `--continue` resumes most recent in current directory
- `--session-id <uuid>` forces a specific session UUID for a new session

### Gemini Sessions
```
Config dir:    ~/.gemini/
Session files: ~/.gemini/tmp/<project-hash>/chats/session-<date>-<short-uuid>.json
Settings:      ~/.gemini/settings.json
Extensions:    ~/.gemini/extensions/
```

**Session ID format:** UUID v4 (e.g., `93b60a72-9197-4237-b861-d4f042b7216c`)

**How sessions are organized:**
- Project hash (SHA-256 of project path) groups sessions
- Session files are named: `session-<ISO-date-truncated>-<8char-uuid>.json`
- Full session JSON includes: sessionId, projectHash, startTime, lastUpdated, messages[]

**Resume mechanics:**
- `--resume latest` resumes most recent
- `--resume <index>` resumes by index number (from `--list-sessions`)
- No direct UUID resume (must use index)
- `--list-sessions` shows: `{index}. {title} ({relative_time}) [{uuid}]`

**Critical gap:** Gemini JSON output (`-o json`) does NOT include session ID. Session ID must be retrieved from `--list-sessions` or from the session file on disk.

### Codex Sessions
```
Config dir:    ~/.codex/
Session files: ~/.codex/sessions/<year>/<month>/<day>/rollout-<date>-<uuid>.jsonl
History:       ~/.codex/history.jsonl
Config:        ~/.codex/config.toml
```

**Session ID format:** UUID v7 / time-ordered UUID (e.g., `019c6a7f-5f3f-7551-a009-73bd70581f24`)

**How sessions are organized:**
- Date-based directory hierarchy: `sessions/2026/02/17/`
- Session files named: `rollout-<ISO-datetime>-<uuid>.jsonl`
- First line of JSONL is `session_meta` with ID, cwd, version, model_provider

**Resume mechanics:**
- `codex resume <SESSION_ID>` resumes by UUID or thread name
- `codex resume --last` resumes most recent
- `codex resume` (no arg) opens interactive picker
- `codex exec resume` resumes in non-interactive mode
- `codex fork` creates a branch from existing session

---

## 7. Analysis & Recommendations

### Session ID Pattern Comparison

| Tool | ID Format | In JSON Output? | In Session Files? | Resume by ID? | Resume by "latest"? |
|------|-----------|-----------------|-------------------|---------------|---------------------|
| Claude | UUID v4 | YES (`session_id` field) | YES (`sessionId` in JSONL) | YES (`--resume <uuid>`) | YES (`--continue`) |
| Gemini | UUID v4 | **NO** | YES (`sessionId` in JSON) | NO (index only) | YES (`--resume latest`) |
| Codex | UUID v7 | N/A (no JSON mode) | YES (`id` in session_meta) | YES (`resume <uuid>`) | YES (`resume --last`) |

### Help Output Parseability

| Tool | Format | Machine-Parseable? | Key Pattern |
|------|--------|--------------------|-------------|
| Claude | Commander.js style | Moderate | `--flag <arg>  Description` with consistent indentation |
| Gemini | Yargs style | Good | `--flag  Description  [type] [default]` |
| Codex | Clap (Rust) style | Good | `--flag <VALUE>` then indented description block |
| git | Custom | Moderate | Categorized sections, `command  Description` |
| docker | Custom | Good | Sectioned (`Common Commands:`, etc.) |
| npm | Custom | Poor | Comma-separated list, needs per-command help |

### Recommended Auto-Detection Patterns

**1. Discover CLI tools:**
```bash
# Scan known names
for tool in claude gemini codex cursor-agent openai mcp adk; do
  path=$(which "$tool" 2>/dev/null)
  [ -n "$path" ] && echo "$tool:$path"
done
```

**2. Get version:**
```bash
$tool --version 2>&1 | head -1
# Claude: "2.1.44 (Claude Code)"
# Gemini: "0.20.2"
# Codex: needs session file or --help header
```

**3. Detect session support:**
```bash
# Check if --help mentions session-related flags
$tool --help 2>&1 | grep -qi "resume\|session\|continue"
```

**4. Get session ID from non-interactive run:**
- **Claude:** `claude --print "prompt" --output-format json 2>&1 | jq -r '.session_id'`
- **Gemini:** NOT available in JSON output. Must parse `gemini --list-sessions` after run.
- **Codex:** Parse session filename from `~/.codex/sessions/` directory, or read first line of latest JSONL.

**5. List sessions:**
- **Claude:** `claude --resume` (interactive picker) or scan `~/.claude/projects/<slug>/*.jsonl`
- **Gemini:** `gemini --list-sessions` (parseable: `N. Title (time) [uuid]`)
- **Codex:** `codex resume` (interactive picker) or scan `~/.codex/sessions/**/*.jsonl`

**6. Resume a session:**
- **Claude:** `claude --resume <uuid>` or `claude --continue`
- **Gemini:** `gemini --resume latest` or `gemini --resume <index>`
- **Codex:** `codex resume <uuid>` or `codex resume --last`

### Key Architectural Insights for Agent Monitor

1. **Claude is the most automation-friendly:** It provides session ID in JSON output, supports direct UUID resume, and has structured stream-json output with typed messages (init, assistant, result).

2. **Gemini has a session ID gap:** The JSON output lacks session ID. Workaround: after each run, call `gemini --list-sessions` and grab the most recent entry. Or monitor `~/.gemini/tmp/*/chats/` for new session files.

3. **Codex lacks JSON output mode:** All output is text-based in non-interactive mode. Session tracking must be done via filesystem monitoring of `~/.codex/sessions/`. The JSONL files are well-structured with `session_meta` as the first line.

4. **All three use UUID-based session IDs** but with different formats (v4 vs v7) and different storage patterns. A unified session manager would need adapters per tool.

5. **`--help` parsing is feasible but fragile:** Each tool uses a different CLI framework (Commander.js, Yargs, Clap). A robust parser should handle multiple formats. Better approach: maintain a known-tool registry with hardcoded capability flags rather than trying to auto-parse help output.

6. **Nested session detection:** Claude sets `CLAUDECODE` env var to prevent nesting. Gemini and Codex don't appear to have this protection. Agent Monitor should be aware of this when spawning sub-agents.

7. **Cost tracking:** Only Claude provides `total_cost_usd` in JSON output. Gemini provides token counts per model. Codex provides nothing in stdout (only in session JSONL).

8. **Process detection:** To find running AI agents, check:
   - `ps aux | grep -E 'claude|gemini|codex'`
   - PM2: `pm2 list` (if managed by PM2)
   - Port scanning is NOT useful (these are CLI tools, not servers)
   - File lock detection: Claude uses `.next/dev/lock` pattern for Next.js but not for its own sessions

### Session File Locations Summary

```
Claude:  ~/.claude/projects/<project-slug>/<uuid>.jsonl
Gemini:  ~/.gemini/tmp/<project-hash>/chats/session-<date>-<uuid-prefix>.json
Codex:   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<datetime>-<uuid>.jsonl
```
