# Agent Monitor - Implementation Phases

> Updated: 2026-02-17

---

## Phase 1: Foundation + App Shell

**Goal**: Project scaffolding, full DB schema, worker skeleton, navigable app shell with empty pages.

### Backend

- [ ] Scaffold: `pnpm create next-app@latest agent-monitor --typescript --tailwind --app --src-dir` (Next.js 16)
- [ ] Install core deps: `drizzle-orm drizzle-kit pg @types/pg zod tsx pg-boss`
- [ ] Write `src/lib/db/schema.ts` with all tables and enums (see 03-data-model.md)
- [ ] Write `drizzle.config.ts`, run `pnpm db:generate && pnpm db:migrate`
- [ ] Write `src/lib/config.ts` -- Zod-validated env config
- [ ] Write `src/lib/errors.ts` -- AppError hierarchy (NotFound, Validation, Conflict, SafetyViolation, Timeout)
- [ ] Write `src/lib/state-machines.ts` -- task and execution status transition tables
- [ ] Write `src/lib/api-handler.ts` -- `withErrorBoundary` wrapper
- [ ] Write `src/lib/api-types.ts` -- response envelope types + `apiFetch` client helper
- [ ] Write `src/lib/types.ts` -- Drizzle inferred types + domain types (TaskInputContext, JsonSchemaObject, SseLogEvent, TaskWithDetails, etc.)
- [ ] Write worker skeleton:
  - `src/lib/worker/queue.ts` -- pg-boss setup, job type registration, send helpers
  - `src/worker/index.ts` -- entry point: `boss.work()` handler, claims job, marks done (no actual execution)
  - pg-boss replaces custom `job-claimer.ts` and `stale-reaper.ts` (see research-queue-systems.md)
- [ ] Zombie process reconciliation on worker startup:
  - Query running/cancelling executions for this worker
  - Check PID existence via `kill(pid, 0)`, mark dead ones as `failed`
  - Must run BEFORE poll loop starts
- [ ] Log retention safety:
  - Add `log_retention_days` to `worker_config` seed data (default: 30)
  - Worker startup: check disk space, refuse new jobs if < 5GB free
  - Basic log cleanup function for files older than retention threshold
- [ ] Cancellation race guard:
  - Worker completion updates include `WHERE status = 'running'` guard
  - If status changed to `cancelling` mid-execution, set `cancelled` not `succeeded`
- [ ] Write `tsconfig.worker.json` for worker build
- [ ] Add process manager config (PM2 entries in `ecosystem.config.js` for instance-neo; Docker Compose alternative documented in 02-architecture.md)
- [ ] Write API route stubs returning `{ data: [] }`:
  - `src/app/api/tasks/route.ts`
  - `src/app/api/agents/route.ts`
  - `src/app/api/executions/route.ts`

### Frontend

- [ ] Install UI deps: `class-variance-authority tailwind-merge clsx lucide-react`
- [ ] Initialize shadcn/ui, add components: Button, Sheet, Table, Badge, Dialog, Tooltip, ScrollArea, Separator
- [ ] Build app shell layout:
  - `src/components/layout/app-shell.tsx` -- sidebar + main content area
  - `src/components/layout/sidebar.tsx` -- nav links, collapsible
  - `src/app/(dashboard)/layout.tsx` -- wraps AppShell
- [ ] Create empty page shells (RSC, empty state):
  - Dashboard (`/`), Tasks (`/tasks`), Agents (`/agents`), Executions (`/executions`)

### Testing

- [ ] Install: `vitest @vitest/coverage-v8`
- [ ] Write `vitest.config.ts` with `@` path alias
- [ ] Unit tests for `state-machines.ts` (transitions, terminal states)
- [ ] Unit tests for `errors.ts` (serialization, `isAppError` type guard)

### Deliverables

- Both processes online (Next.js + worker)
- Worker claims and completes dummy jobs
- Navigable app shell with sidebar, all pages load
- API stubs return `{ data: [] }`
- All unit tests pass

### New packages

```
next@16 react@latest react-dom@latest typescript drizzle-orm drizzle-kit pg @types/pg
zod tsx pg-boss class-variance-authority tailwind-merge clsx lucide-react
vitest @vitest/coverage-v8
```

---

## Phase 2: Agent Auto-Discovery + Registry

**Goal**: Auto-discover CLI tools, "Scan & Confirm" UI, full CRUD for agents and capabilities.

### Backend — Discovery Pipeline

- [ ] Write `src/lib/discovery/scanner.ts`:
  - `scanPATH()` -- scan all PATH directories, deduplicate, resolve symlinks
  - Return `Map<name, { path, realPath, isSymlink }>`
- [ ] Write `src/lib/discovery/identifier.ts`:
  - `identifyBinary(name, path)` -- `dpkg -S` for package name, `apt-cache show` for metadata
  - `getFileType(path)` -- `file` command to detect ELF/script/symlink
  - `getVersion(name)` -- run `--version`, parse first line
- [ ] Write `src/lib/discovery/classifier.ts`:
  - `classifyBinary(info)` -- man page section, systemd check, name patterns
  - Returns: `cli-tool | ai-agent | daemon | interactive-tui | shell-util | admin-tool`
  - Known AI names hardcoded: `claude, gemini, codex, cursor-agent, openai, aichat, ollama`
- [ ] Write `src/lib/discovery/schema-extractor.ts`:
  - Layered: Fig specs lookup → bash-completion parse → regex `--help` parse
  - `getHelpText(toolName)` -- try `--help`, then `-h`, with 5s timeout, `TERM=dumb`, `NO_COLOR=1`
  - `quickParseHelp(helpText)` -- regex extraction of flags and subcommands
  - LLM parse deferred to later phase
- [ ] Write `src/lib/discovery/presets.ts`:
  - Hardcoded configs for known AI tools (Claude, Gemini, Codex)
  - Each preset includes: `sessionConfig`, default capabilities, `envAllowlist`, `interactionMode`
- [ ] Write `src/lib/discovery/index.ts`:
  - `runDiscovery()` -- orchestrates all stages, returns `DiscoveredTool[]`
  - `confirmTool(tool)` -- inserts into `agents` + `agent_capabilities`
- [ ] Write `src/lib/services/agent-service.ts`:
  - `createAgent` -- validate binary path (`accessSync`), generate slug
  - `updateAgent`, `deleteAgent` (cascade to capabilities), `listAgents`, `getAgentById`
  - `createFromDiscovery(tool: DiscoveredTool)` -- bulk insert agent + auto-generated capabilities
- [ ] Write `src/lib/services/capability-service.ts`:
  - CRUD + `toggleApproval` + `testCapability` (runs `which` or `--version`)
  - Validate `interaction_mode` + `command_tokens` consistency
- [ ] Write `src/lib/actions/agent-actions.ts` -- server actions
- [ ] Write `src/lib/actions/capability-actions.ts` -- server actions
- [ ] Write `src/lib/actions/discovery-actions.ts` -- `triggerScan`, `confirmTool`, `dismissTool`
- [ ] Implement API routes:
  - `/api/agents` -- GET, POST
  - `/api/agents/[id]` -- GET, PATCH, DELETE
  - `/api/agents/[id]/capabilities` -- GET, POST
  - `/api/agents/[id]/capabilities/[capId]` -- PATCH, DELETE
  - `/api/discovery/scan` -- POST (trigger scan), GET (list discovered, unconfirmed tools)
  - `/api/discovery/confirm` -- POST (confirm tool → create agent)

### Frontend

- [ ] Build "Scan & Confirm" discovery UI:
  - `discovery-scan-page.tsx` -- "Scan Now" button, progress indicator, results list
  - `discovered-tool-card.tsx` -- tool name, category badge, description, version, "Confirm" / "Dismiss" buttons
  - `discovery-filter-bar.tsx` -- filter by category (AI agents, CLI tools, etc.)
  - First-run experience: auto-trigger scan on first visit to Agents page
- [ ] Build agent registry UI:
  - `agent-table.tsx` (RSC) -- registry list with action buttons + "Rescan" button
  - `agent-row.tsx` ("use client") -- expandable row showing capabilities
  - `agent-status-badge.tsx` -- idle / busy / unavailable indicator
  - `agent-edit-sheet.tsx` ("use client") -- edit binary path, env allowlist, max_concurrent
- [ ] Build capability list UI:
  - `capability-list.tsx` -- rendered inside expanded agent row
  - `capability-row.tsx` -- single capability with danger level indicator
  - `capability-create-dialog.tsx` ("use client") -- manual creation form (for adding custom capabilities)
- [ ] Build basic dynamic form (string + boolean fields only, expand in Phase 6):
  - `schema-form.tsx`, `schema-field.tsx`, `schema-field-string.tsx`, `schema-field-boolean.tsx`
- [ ] Install: `react-hook-form @hookform/resolvers`
- [ ] Update sidebar with live agent count badge

### Testing

- [ ] Unit: PATH scanning with deduplication
- [ ] Unit: binary classification (AI agent detection, daemon detection)
- [ ] Unit: regex help text parsing
- [ ] Integration: create agent from discovered tool, verify slug uniqueness
- [ ] Integration: template capability requires `command_tokens`
- [ ] Integration: prompt capability allows null `command_tokens`
- [ ] Unit: binary path validation logic

### Deliverables

- Auto-discovery scans PATH, classifies tools, extracts schemas
- "Scan & Confirm" page shows discovered tools with categories
- Confirmed tools become agents with auto-generated capabilities
- Agent registry page with CRUD
- Expandable rows show capabilities
- AI tool presets (Claude, Gemini, Codex) auto-detected with session configs
- Basic schema-form renders string and boolean fields from `args_schema`

### New packages

```
react-hook-form @hookform/resolvers
```

---

## Phase 3: Task Management + Kanban Board (Static)

**Goal**: Full task CRUD, dependency management with cycle detection, static Kanban board with task detail sheet.

### Backend

- [ ] Write `src/lib/services/task-service.ts`:
  - `createTask` -- parent_task_id, assignee, sort_order (sparse, gap of 1000)
  - `updateTask` -- status transitions validated against state-machines
  - `deleteTask`, `listTasksByStatus` (cursor-paginated, 50 per status), `getTaskById` (TaskWithDetails)
  - `addDependency` -- cycle detection via transactional DFS with `FOR UPDATE` row locking
  - `removeDependency`, `listSubtasks`
- [ ] Write `src/lib/services/task-event-service.ts` -- audit trail insertion + listing
- [ ] Write `src/lib/actions/task-actions.ts` -- createTask, updateTaskStatus, assignAgent, addDependency, removeDependency
- [ ] Implement API routes:
  - `/api/tasks` -- GET (status filter + cursor pagination), POST
  - `/api/tasks/[id]` -- GET (TaskWithDetails), PATCH, DELETE
  - `/api/tasks/[id]/dependencies` -- GET, POST, DELETE

### Frontend

- [ ] Install: `zustand`
- [ ] Write `src/lib/store/task-board-store.ts` -- `Record<TaskStatus, string[]>` columns, normalized lookup, `hydrate()` and `moveTask()`
- [ ] Build Kanban board (static, no DnD):
  - `task-board.tsx` ("use client") -- column layout, hydrates store from RSC props
  - `task-column.tsx` ("use client") -- single status column with "Load more"
  - `task-card.tsx` ("use client") -- title, agent badge, priority, subtask count, execution indicator
  - `task-card-skeleton.tsx` -- loading placeholder
- [ ] Build task detail sheet (Sheet, not Dialog -- stays open alongside board):
  - `task-detail-sheet.tsx` ("use client") -- right-side slide-in (~40% viewport)
  - `task-detail-header.tsx` -- title, status badge, priority selector
  - `task-meta-panel.tsx` -- assignee dropdown, parent task, due date
  - `task-subtasks-list.tsx` -- child tasks with inline add
  - `task-dependencies-panel.tsx` -- add/remove dependencies, blocked-by list
  - `task-execution-history.tsx` -- past executions (empty until Phase 4)
- [ ] Build task creation:
  - `task-create-dialog.tsx` ("use client") -- new task form
  - `task-quick-add.tsx` ("use client") -- inline add at bottom of each column
- [ ] Wire `tasks/page.tsx` (RSC) to fetch initial board data

### Testing

- [ ] Integration: direct cycle A->B + B->A rejected
- [ ] Integration: transitive cycle A->B->C + C->A rejected
- [ ] Integration: diamond dependency allowed
- [ ] Integration: invalid status transitions rejected (e.g., done -> in_progress)
- [ ] Unit: sparse sort_order calculation (midpoint between neighbors)

### Deliverables

- Kanban board with status columns (todo, in_progress, blocked, done, cancelled)
- Click card to open detail sheet
- Create tasks via dialog or inline quick-add
- Assign agents, add/remove dependencies with cycle detection
- Status changes via dropdown (validated transitions)
- Per-column cursor pagination

### New packages

```
zustand@5
```

---

## Phase 4: Execution Engine + Bidirectional Agent Communication

**Goal**: Worker executes real commands with safety layer, bidirectional adapters per agent (stream-json, JSON-RPC, tmux), all agents spawn inside tmux sessions, web terminal via xterm.js, log streaming via SSE, "Send Message" UI for follow-up messages, session resume.

### Backend — Execution Core

- [ ] Write worker execution modules:
  - `execution-runner.ts` -- core orchestrator with injectable `ProcessSpawner`
  - `safety.ts` -- `validateWorkingDir`, `buildChildEnv` (allowlist, never spread process.env), `buildCommandArgs`, `validateArgs`
  - `log-writer.ts` -- FileLogWriter: open, write stdout/stderr, track byte/line count, close with stats
  - `heartbeat.ts` -- per-execution 30s heartbeat timer
  - Note: `stale-reaper.ts` removed — pg-boss handles job expiration via `expireInMinutes`
- [ ] Update `src/worker/index.ts` to use real execution runner
- [ ] Write `src/lib/services/execution-service.ts`:
  - `createExecution` -- validate capability + args, insert queued
  - `cancelExecution` -- set cancelling, worker sends SIGTERM then SIGKILL
  - `getExecutionById` (ExecutionWithDetails), `listExecutions` (paginated, filterable)
- [ ] Write `src/lib/services/log-service.ts` -- log path resolution, full content read
- [ ] Write `src/lib/actions/execution-actions.ts` -- triggerExecution, cancelExecution, sendMessage
- [ ] Implement API routes:
  - `/api/executions` -- GET, POST
  - `/api/executions/[id]` -- GET (detail with agent + capability)
  - `/api/executions/[id]/cancel` -- POST (sets cancelling)
  - `/api/executions/[id]/logs` -- GET (full log download)
  - `/api/executions/[id]/logs/stream` -- GET (SSE live tail: catch-up + fs.watch + poll fallback)
  - `/api/executions/[id]/message` -- POST (send follow-up message to running agent)
  - `/api/workers/status` -- GET (worker heartbeat check)

### Backend — Bidirectional Adapter Modules

- [ ] Write `src/lib/worker/adapters/adapter-interface.ts`:
  - `AgentAdapter` interface: `start()`, `sendMessage()`, `interrupt()`, `extractSessionId()`, `buildResumeArgs()`, `onOutput(callback)`, `getTmuxSessionName()`, `stop()`
  - All adapters spawn their agent inside a tmux session for web terminal access
- [ ] Write `src/lib/worker/adapters/claude-adapter.ts`:
  - Launch Claude CLI with `--input-format stream-json --output-format stream-json --verbose`
  - Spawn inside tmux session: `tmux new-session -d -s "claude-{executionId}" -x 200 -y 50`
  - Parse NDJSON stdout for `system` (extract `session_id`), `assistant`, `result` messages
  - `sendMessage()` -- write NDJSON `{"type":"user","message":{"role":"user","content":"..."}}` to stdin
  - `interrupt()` -- send SIGINT to child process
  - Session resume via `--resume {sessionId}` flag
  - Note: NO Agent SDK dependency -- uses CLI stream-json protocol directly
- [ ] Write `src/lib/worker/adapters/codex-adapter.ts`:
  - Launch `codex app-server` as subprocess, communicate via JSON-RPC 2.0 over stdio
  - Spawn inside tmux session: `tmux new-session -d -s "codex-{executionId}" -x 200 -y 50`
  - Initialization handshake: send `initialize` request + `initialized` notification
  - `start()` -- `thread/start` with model, cwd, approvalPolicy
  - `sendMessage()` -- `turn/start` with threadId and text input
  - `interrupt()` -- `turn/interrupt` with threadId and turnId
  - Parse notifications: `item/agentMessage/delta` (streaming text), `turn/completed`, `item/commandExecution/outputDelta`
  - Session resume via `thread/resume` JSON-RPC method
- [ ] Write `src/lib/worker/adapters/gemini-adapter.ts`:
  - Launch Gemini CLI in interactive mode inside tmux session
  - Use `gemini -i "{initialPrompt}"` for prompt-interactive mode (processes initial prompt, stays alive)
  - `sendMessage()` -- `tmux send-keys -t "gemini-{executionId}" -l "{message}"` + `tmux send-keys Enter`
  - `captureOutput()` -- `tmux capture-pane -t "gemini-{executionId}" -p -S -1000`
  - Poll-based output detection: 500ms interval, detect Gemini `>` prompt for completion
  - No native session resume -- tmux session persists across server restarts
- [ ] Write `src/lib/worker/adapters/template-adapter.ts`:
  - Simple `spawn(shell: false)` for template-mode CLI tools (non-AI agents)
  - Spawn inside tmux session for consistency
  - No bidirectional support -- fire-and-forget execution
  - No session resume
- [ ] Write `src/lib/worker/tmux-manager.ts`:
  - `createSession(name, command, cwd)` -- `tmux new-session -d -s {name} -x 200 -y 50 -c {cwd} {command}`
  - `sendInput(name, text)` -- `tmux send-keys -t {name} -l {text}`
  - `pressEnter(name)` -- `tmux send-keys -t {name} Enter`
  - `capturePane(name, historyLines)` -- `tmux capture-pane -t {name} -p -S -{historyLines}`
  - `hasSession(name)` -- `tmux has-session -t {name}`
  - `killSession(name)` -- `tmux kill-session -t {name}`
  - `resizeSession(name, cols, rows)` -- `tmux resize-window -t {name} -x {cols} -y {rows}`
  - `listSessions()` -- `tmux list-sessions -F "#{session_name}"`

### Backend — WebSocket Terminal Server

- [ ] Write `src/terminal/server.ts` -- separate process on port `:4101`:
  - Socket.io server with CORS configured for Next.js origin
  - On `connection`: validate `sessionId` query param, look up tmux session name
  - Spawn `node-pty` process running `tmux attach-session -t {tmuxSessionName}`
  - Forward PTY output to browser via `terminal:output` event
  - Forward browser input to PTY via `terminal:input` event
  - Handle `terminal:resize` event -- resize PTY + tmux window
  - On `disconnect`: do NOT kill PTY (allow reattach)
  - Session map: `Map<executionId, { tmuxName, ptyProcess }>`
- [ ] Add PM2 entry in `ecosystem.config.js` for terminal server process
- [ ] Write `src/terminal/auth.ts` -- validate session tokens on WebSocket handshake

### Frontend — Execution UI

- [ ] Install: `ansi-to-html isomorphic-dompurify`
- [ ] Write `src/lib/log-renderer.ts` -- ANSI to HTML + DOMPurify sanitization (ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['style'])
- [ ] Write `src/lib/hooks/use-execution-log-stream.ts` -- EventSource hook: subscribe, append, reconnect, detect completion
- [ ] Build execution trigger UI:
  - `execution-trigger-dialog.tsx` ("use client") -- capability select, schema-form for args, danger warning for level >= 2
- [ ] Build log viewer:
  - `execution-log-viewer.tsx` ("use client") -- terminal-style, monospace, colored lines (stdout: zinc-100, stderr: amber-400, system: blue-400), sanitized HTML
  - `execution-log-toolbar.tsx` -- search, wrap toggle, auto-scroll toggle, download
  - Auto-scroll: scroll on new lines, pause on user scroll-up, "Scroll to bottom" button
  - DOM cap: max 5,000 visible lines, sliding window, truncation banner
- [ ] Build execution list UI:
  - `execution-table.tsx` (RSC), `execution-row.tsx`, `execution-status-badge.tsx`, `execution-cancel-button.tsx` ("use client")
- [ ] Wire task detail sheet to show execution history + "Run" button

### Frontend — Bidirectional Communication UI

- [ ] Build "Send Message" panel on execution detail page:
  - `execution-message-input.tsx` ("use client") -- text input + send button, shown only when execution status is `running`
  - Calls `POST /api/executions/[id]/message` with message body
  - Disabled with tooltip when agent adapter does not support bidirectional (template-adapter)
  - Message history displayed in log viewer with distinct styling (user messages: green-400 prefix)
- [ ] Build session resume UI:
  - "Continue Session" button on execution detail (shown when `session_ref` exists and execution is completed/succeeded)
  - Creates new execution with `parentExecutionId` linking to original
  - Adapter calls `--resume {sessionId}` (Claude) or `thread/resume` (Codex) or reuses tmux session (Gemini)
  - Session chain indicator on task card (e.g., "3 turns")

### Frontend — Web Terminal

- [ ] Install: `@xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-search @xterm/addon-webgl socket.io-client`
- [ ] Write `src/components/terminal/terminal-component.tsx` ("use client"):
  - Dynamic import with `ssr: false` (xterm.js requires `window`)
  - Initialize Terminal with cursorBlink, JetBrains Mono font, dark theme
  - Load addons: FitAddon, WebLinksAddon, SearchAddon, WebglAddon (with DOM fallback)
  - ResizeObserver for auto-fit
  - Connect to Socket.io server on `:4101` with `sessionId` query param
  - Forward `terminal:output` to `terminal.write()`, forward `terminal.onData()` to `terminal:input`
  - Handle resize: `terminal.onResize()` -> `terminal:resize` event
- [ ] Write `src/components/terminal/terminal-toolbar.tsx` -- search input, font size, fullscreen toggle
- [ ] Build terminal attachment UI:
  - "Open Terminal" button on execution detail page (shown when tmux session exists)
  - Opens terminal in expandable bottom panel or fullscreen overlay
  - Multiple users can attach to same tmux session simultaneously
- [ ] Wire `executions/[id]/terminal/page.tsx` -- fullscreen web terminal page
- [ ] Wire executions pages: list page + `executions/[id]/page.tsx` (log viewer + message input + terminal button)

### Testing

- [ ] Unit: `buildCommandArgs` -- substitution, missing required arg throws, object values rejected
- [ ] Unit: `validateWorkingDir` -- allowlist check, symlink traversal blocked
- [ ] Unit: `buildChildEnv` -- only allowlisted vars, no process.env leak
- [ ] Worker: `runExecution` with mock ProcessSpawner -- correct args, status transitions, log writing
- [ ] Unit: Claude adapter parses NDJSON output, extracts session_id from `system` init message
- [ ] Unit: Claude adapter sends follow-up message as NDJSON to stdin
- [ ] Unit: Codex adapter sends JSON-RPC initialize handshake correctly
- [ ] Unit: Codex adapter sends `turn/start` and parses `turn/completed` notification
- [ ] Unit: Gemini adapter sends message via `tmux send-keys` and detects completion via `>` prompt
- [ ] Unit: TmuxManager creates/kills sessions, captures pane output
- [ ] Integration: create execution, worker claims and completes, log file created
- [ ] Integration: session resume creates new execution linked to parent
- [ ] Integration: send follow-up message to running Claude execution via adapter
- [ ] Integration: WebSocket terminal server attaches to tmux session

### Deliverables

- "Run" button triggers execution with capability selection and arg form
- Worker executes via agent-specific bidirectional adapters:
  - Claude: stream-json NDJSON over stdin/stdout (CLI, no SDK)
  - Codex: JSON-RPC 2.0 via `codex app-server` subprocess
  - Gemini: tmux send-keys / capture-pane (interactive mode)
  - Generic: simple spawn for non-AI CLI tools
- All agents spawn inside tmux sessions for web terminal access
- "Send Message" UI sends follow-up messages to running agents
- Web terminal (xterm.js + node-pty + Socket.io) attaches to any agent's tmux session
- WebSocket terminal server on `:4101` as separate PM2 process
- Safety layer enforced: working dir, env stripping, arg validation, timeout, output cap
- Live log streaming via SSE with ANSI colors
- Cancel via SIGTERM with SIGKILL fallback
- "Continue Session" button for session resume (Claude `--resume`, Codex `thread/resume`, Gemini tmux reuse)
- Execution history on task detail and global executions page
- Worker heartbeat active

### New packages

```
ansi-to-html isomorphic-dompurify
@xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-search @xterm/addon-webgl
socket.io socket.io-client node-pty
```

---

## Phase 5: Drag-and-Drop + Real-Time Board Updates

**Goal**: DnD for Kanban reordering and cross-column moves, SSE for live board state.

### Backend

- [ ] Implement reorder API:
  - `/api/tasks/[id]/reorder` -- POST: update sort_order + optionally status
  - Sparse sort_order: midpoint between neighbors, reindex column when gap < 1
- [ ] Implement SSE board endpoint:
  - `/api/sse/board` -- SSE stream for task changes (created, status changed, assigned, deleted)
  - 2s polling fallback (upgrade to Postgres LISTEN/NOTIFY in later phase)

### Frontend

- [ ] Install: `@dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
- [ ] Upgrade board for DnD:
  - `task-board.tsx` -- wrap in DndContext, DragOverlay, closestCorners collision
  - `task-column.tsx` -- useDroppable
  - `task-card.tsx` -- useSortable, drag handle
- [ ] Optimistic updates in Zustand:
  - `moveTask` -- snapshot, apply immediately, server action in background, rollback on failure with toast
  - `reorderTask` -- same pattern for within-column
- [ ] Write `src/lib/hooks/use-board-sse.ts` -- subscribe to `/api/sse/board`, apply updates, exponential backoff reconnect, merge with pending optimistic moves
- [ ] Keyboard accessibility for DnD (built into @dnd-kit)
- [ ] Write `src/lib/store/execution-store.ts` -- execution_id -> status map, updated by board SSE

### Testing

- [ ] Unit: optimistic move + rollback on failure
- [ ] Unit: sparse sort_order calculation and reindex trigger
- [ ] Integration: within-column reorder persists correct sort_order
- [ ] Integration: cross-column move updates status + sort_order

### Deliverables

- Drag cards to reorder within column and between columns
- Optimistic UI with rollback on server failure
- Live board updates via SSE
- DragOverlay with floating card during drag
- Keyboard-accessible DnD

### New packages

```
@dnd-kit/core@6 @dnd-kit/sortable@8 @dnd-kit/utilities@3
```

---

## Phase 6: Dashboard + MCP Server + Polish

**Goal**: Dashboard with stats, Agent Monitor MCP server (lets AI agents manage tasks), complete schema-form fields, virtual scrolling, loop prevention, polish pass.

### Backend — Dashboard + Maintenance

- [ ] Dashboard data queries: task counts by status, active executions, queued count, failed (24h), recent events
- [ ] Log rotation: cron to delete logs older than 30 days
- [ ] Worker status enhancement: current execution count, uptime, last claim time

### Backend — Agent Monitor MCP Server

- [ ] Write `src/lib/mcp/server.ts` -- MCP server using `@modelcontextprotocol/sdk`:
  - Uses `StdioServerTransport` for CLI integration (spawned as subprocess by AI agents)
  - Uses `StdioServerTransport` (stdio, not a network port) — calls the Next.js API at `http://localhost:4100`
  - Reads `AGENT_MONITOR_URL` env var (default: `http://localhost:4100`)
  - All tools call Agent Monitor REST API endpoints internally
- [ ] Implement MCP tools:
  - `create_task` -- title, description, priority, assignee, parentTaskId, tags -> `POST /api/tasks`
  - `update_task` -- taskId, status, assignee, description, priority -> `PATCH /api/tasks/[id]`
  - `list_tasks` -- status filter, assignee filter, parentTaskId -> `GET /api/tasks`
  - `create_subtask` -- parentTaskId, title, description, assignee -> `POST /api/tasks` (with parentTaskId)
  - `assign_task` -- taskId, agentSlug -> `PATCH /api/tasks/[id]`
- [ ] Write `src/lib/mcp/build.ts` -- build script to bundle MCP server as standalone `dist/mcp-server.js`
- [ ] Write `--mcp-config` integration for spawned agent instances:
  - When spawning Claude: add `--mcp-config` flag pointing to `.mcp.json` with agent-monitor server
  - When spawning Codex: write `[mcp_servers.agent-monitor]` section to temp config
  - When spawning Gemini: add to `mcpServers` in settings, OR use REST API fallback (curl in agent prompt)
- [ ] Loop prevention safeguards:
  - Depth limit: track `spawn_depth` on executions table, reject spawns where depth >= 3
  - Budget cap: per-task cumulative cost tracking, reject new executions when task exceeds budget limit
  - Concurrency limit: max 3 concurrent AI agent executions (configurable in `worker_config`)
  - Rate limit on MCP `create_task` tool: max 10 tasks per agent per minute
- [ ] REST API fallback for Gemini:
  - Gemini does not reliably load MCP servers in all contexts
  - When spawning Gemini, inject curl-based instructions into the agent prompt:
    ```
    To create a task: curl -X POST http://localhost:4100/api/tasks -H "Content-Type: application/json" -d '{"title":"...","status":"todo"}'
    To update a task: curl -X PATCH http://localhost:4100/api/tasks/{id} -H "Content-Type: application/json" -d '{"status":"done"}'
    ```

### Frontend — Dashboard

- [ ] Build dashboard:
  - `stats-grid.tsx` (RSC) -- 4 stat cards
  - `active-executions-list.tsx` ("use client") -- live running executions with cancel
  - `recent-tasks-feed.tsx` -- latest task events
  - `agent-health-grid.tsx` -- agent availability (running vs max_concurrent)
- [ ] Complete schema-form field types:
  - `schema-field-number.tsx`, `schema-field-enum.tsx`, `schema-field-array.tsx`, `schema-field-object.tsx`
  - Install: `json-schema-to-zod` for runtime JSON Schema -> Zod conversion
  - Wire `zodResolver` for automatic form validation
- [ ] Virtual scrolling for executions table:
  - Install: `@tanstack/react-virtual`
  - Apply `useVirtualizer` to execution-table.tsx
- [ ] Sidebar enhancements: live agent status, badge counts (running executions, queued tasks)
- [ ] Command palette: `/` shortcut with shadcn Command for task search
- [ ] Polish pass:
  - Loading skeletons for all data-fetching components
  - Empty states with helpful messages
  - Error boundaries for graceful degradation
  - Toast notifications for mutations
  - Responsive: horizontal scroll for board < 1280px, min-w-[280px] columns

### Testing

- [ ] Unit: json-schema-to-zod conversion for all field types
- [ ] Integration: dashboard stats query returns correct counts
- [ ] Unit: MCP server `create_task` tool calls correct REST endpoint
- [ ] Unit: MCP server `list_tasks` tool formats output correctly
- [ ] Integration: MCP server end-to-end -- spawn server, call tool, verify task created in DB
- [ ] Unit: loop prevention -- depth limit rejects spawn at depth >= 3
- [ ] Unit: loop prevention -- budget cap rejects execution when task cost exceeds limit
- [ ] Manual: virtual scrolling with 1000+ rows

### Deliverables

- Dashboard with live stats, active executions, recent activity
- Agent Monitor MCP server (`dist/mcp-server.js`) with 5 task management tools
- Spawned Claude/Codex instances auto-configured with `--mcp-config` to use Agent Monitor MCP server
- Gemini uses REST API fallback (curl instructions in prompt)
- Loop prevention: depth limit (3), budget cap, concurrency limit (3), rate limit on task creation
- Complete dynamic form from any valid `args_schema`
- Virtual scrolling on executions table
- Command palette for task search
- Loading states, empty states, error boundaries throughout
- Log rotation cron active

### New packages

```
json-schema-to-zod@2 @tanstack/react-virtual@3 @modelcontextprotocol/sdk
```

---

## Deferred (Later Phases)

### Advanced Discovery

- LLM-assisted `--help` parsing: send help text to Claude/Gemini with structured output schema, cache result
- Fig specs import from `withfig/autocomplete` repo (500+ tools with structured CLI schemas)
- MCP client integration: discover tools from MCP servers via `@modelcontextprotocol/sdk`, import from MCP Registry (~2000 servers)
- Zsh completion parsing (`_arguments` declarations = declarative CLI schemas)
- tldr-pages as seed database for common CLI descriptions

### Advanced Agent Communication

- Claude Agent SDK integration: use `@anthropic-ai/claude-agent-sdk` V2 `send()`/`stream()` for richer Claude control (tool approval via `canUseTool`, hooks for event-driven integration, model switching mid-session)
- Codex approval flow forwarding: forward `requestApproval` JSON-RPC events to web UI for user confirmation
- tmux control mode (`-CC`): machine-friendly tmux protocol for building custom tmux client in Node.js without node-pty
- Session forking (Claude: `--fork-session`, Codex: `codex fork`)
- Cost tracking aggregation per task (Claude provides `total_cost_usd`, Codex token counts)
- Session browser: list all sessions per agent from filesystem
- Gemini native bidirectional support (when `--input-format stream-json` is added per GitHub issue #8203)

### Advanced UI

- Full dependency graph visualization (DAG)
- Mobile-responsive UI (< 1024px) with virtual d-pad controls for terminal
- Agent performance analytics and cost dashboards
- Multi-user concurrent terminal viewing with user cursors

### Collaboration

- Team workspaces + RBAC, webhook integrations, export/import

### Infrastructure

- Authentication (session token or HTTP Basic via nginx)
- Postgres LISTEN/NOTIFY for zero-latency board SSE
- Automatic task status transitions on execution completion
