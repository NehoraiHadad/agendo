# Research: Web UI Wrappers and Frontends for AI CLI Tools

**Date:** 2026-02-17
**Purpose:** Landscape analysis for "Agent Monitor" — a web UI for managing AI CLI agents

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Master Project Comparison Table](#2-master-project-comparison-table)
3. [Claude Code UI Wrappers](#3-claude-code-ui-wrappers)
4. [Gemini CLI UI Wrappers](#4-gemini-cli-ui-wrappers)
5. [Codex CLI UI Wrappers](#5-codex-cli-ui-wrappers)
6. [Multi-Tool / Universal Agent UIs](#6-multi-tool--universal-agent-uis)
7. [General AI Agent UI Frameworks](#7-general-ai-agent-ui-frameworks)
8. [Terminal-in-Browser Approaches](#8-terminal-in-browser-approaches)
9. [Architecture Patterns Analysis](#9-architecture-patterns-analysis)
10. [Key Technical Approaches Categorized](#10-key-technical-approaches-categorized)
11. [Connection Pattern Code Snippets](#11-connection-pattern-code-snippets)
12. [Protocols and Standards](#12-protocols-and-standards)
13. [Recommendations](#13-recommendations)
14. [Links and References](#14-links-and-references)

---

## 1. Executive Summary

The ecosystem of web UI wrappers for AI CLI tools has exploded since mid-2025. There are now **20+ active projects** providing web or desktop frontends for Claude Code alone, with additional wrappers for Gemini CLI, Codex CLI, and multi-tool solutions.

**Key findings:**

- **Claude Code has the richest ecosystem** of UI wrappers, driven by its CLI-first design and the SDK's subprocess architecture
- **The Claude Agent SDK** (formerly Claude Code SDK) is the most robust integration point — it wraps the CLI as a subprocess and streams NDJSON events
- **A hidden `--sdk-url` flag** in Claude Code redirects output to a WebSocket server, which several projects exploit (The Companion, claude-code-web)
- **tmux + git worktree** is the dominant pattern for multi-agent session isolation (Claude Squad, CCManager)
- **SSE (Server-Sent Events)** is the most common streaming protocol for web UIs
- **Electron and Tauri** are the two desktop app frameworks being used (Claudia/Opcode uses Tauri+Rust, AionUi and others use Electron)
- **Multi-tool UIs** are emerging: AionUi, CC-Switch, and CCManager all support Claude Code + Gemini CLI + Codex CLI in a single interface
- **AG-UI Protocol** (by CopilotKit) is an emerging open standard for agent-to-frontend communication

---

## 2. Master Project Comparison Table

### Claude Code Specific UIs

| Project | Stars | Tech Stack | Connection Method | Multi-Agent | Mobile | Status |
|---------|-------|-----------|-------------------|-------------|--------|--------|
| **Happy** (slopus) | ~7,000 | Expo (React Native), Node.js | CLI subprocess + encrypted WebSocket relay | No | Yes (iOS/Android/Web) | Active |
| **CloudCLI** (siteboon) | ~5,400 | React 18, Node.js, CodeMirror | Claude Agent SDK subprocess | No | Yes (responsive) | Active |
| **CUI** (wbopan) | ~1,100 | React, Tailwind, Node.js/TS | Claude Code subprocess via cui-server | Yes (parallel background agents) | Yes (PWA) | Active |
| **claude-code-webui** (sugyan) | ~820 | React, Hono, Deno/Node.js | Claude Code SDK + SSE streaming | No | Yes (responsive) | Active |
| **claude-code-web** (vultuk) | ~500 | Express, WebSocket | CLI process + WebSocket bridge | Yes (multi-session) | No | Active |
| **The Companion** (The-Vibe-Company) | ~400 | React, Bun, Hono | `--sdk-url` WebSocket + NDJSON | Yes (multi-session) | Yes (responsive) | Active (uses hidden API) |
| **Claudia/Opcode** (marcusbey) | ~350 | Tauri 2, Rust, React 18, SQLite | CLI subprocess | Yes (custom agents) | No (desktop) | Active (rebranded to Opcode) |
| **claude-code-web** (sunpix) | ~200 | Nuxt 4, Vue | CLI subprocess | No | Yes (PWA) | Active |
| **Claude Code by Agents** (baryhuang) | ~200 | Electron, Node.js | CLI subprocess + orchestrator API | Yes (@mention routing) | No (desktop) | Active |
| **claude-agent-server** (dzhng) | ~180 | Node.js, E2B sandbox | Claude Agent SDK + WebSocket | No | N/A (server) | Active |
| **Claude Squad** (smtg-ai) | ~5,600 | Go, bubbletea TUI | tmux sessions + git worktree | Yes (core feature) | No (terminal) | Very Active |
| **Claude Flow** (ruvnet) | ~3,000 | TypeScript, npm | MCP protocol + swarm orchestration | Yes (swarm) | No | Active |

### Gemini CLI UIs

| Project | Stars | Tech Stack | Connection Method | Status |
|---------|-------|-----------|-------------------|--------|
| **Gemini CLI Desktop** (Piebald-AI) | ~300 | Tauri, Rust, React | CLI subprocess (Rocket web server) | Active |
| **Gemini-CLI-UI** (cruzyjapan) | ~200 | React, WebSocket | CLI subprocess + WebSocket | Active |
| **Gemini CLI Web** (ssdeanx) | ~150 | React 18, CodeMirror/Monaco | CLI subprocess + REST API | Active |
| **Gemini Web Wrapper** (Ven0m0) | ~100 | FastAPI, static HTML/JS | Gemini API (HTTP, not CLI) | Active |

### Multi-Tool / Universal UIs

| Project | Stars | Tools Supported | Tech Stack | Status |
|---------|-------|----------------|-----------|--------|
| **AionUi** (iOfficeAI) | ~2,000 | Claude Code, Gemini CLI, Codex, OpenCode, Qwen, Goose, Auggie | Electron, SQLite | Active |
| **CCManager** (kbwo) | ~500 | Claude Code, Gemini CLI, Codex, Cursor Agent, Copilot CLI, Cline, OpenCode, Kimi CLI | Go (TUI) | Active |
| **CC-Switch** (farion1231) | ~400 | Claude Code, Codex, OpenCode, Gemini CLI | Electron (desktop) | Active |

### General AI Chat/Agent UIs

| Project | Stars | Focus | Tech Stack | Status |
|---------|-------|-------|-----------|--------|
| **Open WebUI** | ~124,000 | Multi-LLM chat UI | FastAPI, SvelteKit | Very Active |
| **LobeChat** | ~60,000+ | Multi-agent chat | Next.js, TypeScript | Very Active |
| **Chatbot UI** (mckaywrigley) | ~30,000+ | ChatGPT-style UI | Next.js, Supabase | Active |
| **OpenClaw** | ~147,000 | Personal AI assistant | Multi-platform | Very Active |
| **Superinterface** | ~500 | Embeddable AI chat | React components | Active |

---

## 3. Claude Code UI Wrappers

### 3.1 Happy (slopus/happy)

**Repository:** https://github.com/slopus/happy
**Website:** https://happy.engineering/
**Stars:** ~7,000

**Architecture:**
Happy is a mobile-first client for Claude Code and Codex with end-to-end encryption. It consists of three components:

1. **happy-cli** — Local CLI that wraps Claude Code, runs on your dev machine
2. **happy-server** — Encrypted relay server (handles only encrypted blobs)
3. **happy-app** — Mobile/web client (Expo for iOS/Android, web)

**Connection pattern:** CLI subprocess -> E2E encrypted WebSocket relay -> Mobile app

**How it works:**
- User scans a QR code to establish shared encryption secret
- happy-cli spawns Claude Code as a subprocess locally
- All messages are encrypted before leaving the machine
- Relay server passes encrypted blobs (zero-knowledge)
- Bidirectional real-time sync — can initiate conversations from phone or desktop
- Push notifications when agents need attention

**Key insight:** The relay server architecture means you don't need direct network access to your dev machine. Privacy-first design.

**Tech stack:** Node.js, Expo (React Native), WebSocket, E2E encryption

---

### 3.2 CloudCLI / Claude Code UI (siteboon/claudecodeui)

**Repository:** https://github.com/siteboon/claudecodeui
**Website:** https://claudecodeui.siteboon.ai/
**Stars:** ~5,400
**npm:** `@siteboon/claude-code-ui`

**Architecture:**
- **Frontend:** React 18 with hooks
- **Code editor:** CodeMirror for syntax highlighting and live editing
- **Build tool:** Vite
- **Backend:** Node.js server with Claude Agent SDK integration
- **Deployment:** PM2 for production, Docker supported

**Connection pattern:** Browser -> Node.js server -> Claude Agent SDK subprocess

**Features:**
- Interactive chat interface
- Built-in shell terminal (direct access to Claude Code CLI)
- File explorer with syntax highlighting and live editing
- Responsive design (desktop, tablet, mobile)
- Session management

**License:** GPL v3

---

### 3.3 CUI (wbopan/cui)

**Repository:** https://github.com/wbopan/cui
**Stars:** ~1,100

**Architecture:**
```
Browser (React + Tailwind) <-> WebRTC/WebSocket <-> cui-server (Node.js/TS) <-> Claude Code binary
```

**Connection pattern:** Browser -> cui-server (Node.js proxy with auth token gate) -> Claude Code subprocess

**Key features:**
- **Parallel background agents** — stream multiple Claude Code sessions simultaneously
- **Task management** — fork, resume, archive conversations
- **Multi-model support** for agentic workflows
- **Push notifications** and **dictation** (powered by Gemini 2.5 Flash)
- Claude Code parity — familiar autocompletion and CLI interaction

**Requirements:** Node.js >= 20.19.0 (ships native ESM + top-level await)

---

### 3.4 claude-code-webui (sugyan)

**Repository:** https://github.com/sugyan/claude-code-webui
**Stars:** ~820
**npm:** `claude-code-webui`

**Architecture (Three-tier):**
1. **React frontend** — useClaudeStreaming hook processes SSE responses
2. **Runtime-agnostic backend** — supports both Deno and Node.js via runtime abstraction layer
3. **Claude Code SDK integration** — subprocess transport

**Connection pattern:** Browser -> SSE (Server-Sent Events) -> Backend -> Claude Code SDK subprocess

**Streaming protocol:**
- Uses **SSE** with discriminated union message types
- Types defined in `shared/types.ts`
- Type guard functions: `isChatMessage()`, `isSystemMessage()`, etc.
- Messages processed incrementally via the `useClaudeStreaming` hook

**Deployment options:**
- npm global install: `npm install -g claude-code-webui`
- Standalone binary releases
- Docker

---

### 3.5 The Companion (The-Vibe-Company)

**Repository:** https://github.com/The-Vibe-Company/companion
**Stars:** ~400

**Architecture:**
- **Frontend:** React
- **Backend:** Bun + Hono
- **Connection:** Exploits Claude Code's hidden `--sdk-url` flag

**The `--sdk-url` discovery:**
The developers found an undocumented flag hidden with `.hideHelp()` in Claude Code's Commander configuration. When `--sdk-url` is set, the CLI transforms from an interactive terminal tool into a **WebSocket client** that emits **NDJSON** (newline-delimited JSON) to the specified URL.

**Connection pattern:**
```
Claude Code CLI --sdk-url ws://localhost:PORT -> Companion WebSocket Server -> React Frontend
```

**WARNING:** This relies on a hidden, unsupported protocol. If Anthropic removes `--sdk-url`, the tool breaks.

**Features:**
- Token-by-token response streaming
- Collapsible bash commands and file edits with syntax highlighting
- Multiple session support
- Visual tool tracking and persistent context

---

### 3.6 claude-code-web (vultuk)

**Repository:** https://github.com/vultuk/claude-code-web
**Stars:** ~500
**npm:** `claude-code-web`

**Architecture:**
```
server.js (Express + WebSocket) -> claude-bridge.js (Process Manager) -> Claude Code CLI
                                -> session-store.js (Persistence)
                                -> auth.js (Token auth)
```

**Connection pattern:** Browser -> WebSocket -> Express server -> Claude Code process bridge

**Key features:**
- **Multi-session:** Create and manage multiple persistent Claude sessions
- **Multi-browser:** Connect to the same session from different browsers/devices
- **Session persistence:** Sessions remain active when disconnecting
- **VS Code-style split view** with draggable tabs
- **Auto-generated auth tokens** (enabled by default since v2.0.0)

---

### 3.7 Claudia / Opcode (marcusbey/claudia)

**Repository:** https://github.com/marcusbey/claudia (now https://github.com/getAsterisk/claudia)
**Website:** https://claudiacode.com/ (redirects to opcode.sh)
**Stars:** ~350

**Architecture:**
- **Frontend:** React 18 + TypeScript + Tailwind CSS v4 + shadcn/ui
- **Backend:** Rust with Tauri 2
- **Database:** SQLite via rusqlite
- **Package manager:** Bun

**Connection pattern:** Tauri IPC -> Rust backend -> Claude Code CLI subprocess

**Key features:**
- Visual project browser (`~/.claude/projects/`)
- MCP server management UI
- **Session versioning** — create checkpoints, visual timeline, one-click restore
- Session forking and diff viewer between checkpoints
- Custom agent creation
- Usage tracking

**Note:** Project has been rebranded from "Claudia" to "Opcode".

---

### 3.8 Claude Squad (smtg-ai/claude-squad)

**Repository:** https://github.com/smtg-ai/claude-squad
**Website:** https://smtg-ai.github.io/claude-squad/
**Stars:** ~5,600

**Architecture (Go + tmux + git worktree):**
```
main.go -> app.Run() -> [session.Instance] -> tmux.TmuxSession (terminal isolation)
                                            -> git.GitWorktree (code isolation)
         -> UI (bubbletea TUI + lipgloss)
         -> session.Storage (persistence)
         -> daemon.RunDaemon() (auto-approval automation)
```

**Connection pattern:** TUI -> tmux session management -> CLI processes in tmux panes

**How it works:**
1. Each AI agent (Claude Code, Codex, Aider, etc.) runs in its own **tmux session**
2. Each agent gets its own **git worktree** on a separate branch
3. **Dual isolation:** terminal process isolation + code branch isolation
4. **Daemon system** monitors tmux sessions and auto-sends keystrokes for prompt acceptance
5. **bubbletea** TUI framework for navigation between sessions

**NOT a web UI** — it's a terminal UI. But its tmux architecture is the most proven pattern for multi-agent isolation and could be adapted for web access.

**Supported agents:** Claude Code, Codex, Aider, OpenCode, Amp

---

### 3.9 Claude Flow (ruvnet/claude-flow)

**Repository:** https://github.com/ruvnet/claude-flow
**npm:** `claude-flow`
**Stars:** ~3,000

**Architecture:**
Multi-layer orchestration platform:
1. CLI or Claude Code interface (input)
2. Intelligent routing layer
3. Specialized agent swarms
4. LLM providers (output)

**Connection pattern:** MCP protocol -> Agent orchestrator -> Swarm of Claude Code instances

**Key features:**
- **87 MCP tools** for swarm orchestration, memory, and automation
- Agents organize into swarms led by "queens" for coordination
- **Vector memory** stores successful patterns
- **Knowledge graph** for structural understanding
- **Neural network** learning from outcomes
- Session persistence with background daemons
- WebSocket server support for real-time communication

**Note:** Claims "#1 in agent-based frameworks" — evaluate independently.

---

### 3.10 claude-agent-server (dzhng)

**Repository:** https://github.com/dzhng/claude-agent-server
**Stars:** ~180

**Architecture:**
```
Your App -> WebSocket Client (@dzhng/claude-agent) -> E2B Sandbox -> claude-agent-server -> Claude Agent SDK -> Anthropic API
```

**Connection pattern:** WebSocket -> E2B cloud sandbox -> Claude Agent SDK

**Key insight:** Runs Claude Agent (the harness behind Claude Code) in an **E2B sandbox** — cloud-hosted, ephemeral environments. Great for multi-tenant or SaaS use cases where you can't run CLI on user machines.

**Requirements:** E2B_API_KEY + ANTHROPIC_API_KEY

---

### 3.11 Claude Code by Agents (baryhuang)

**Repository:** https://github.com/baryhuang/claude-code-by-agents
**Website:** https://claudecode.run/
**Stars:** ~200

**Architecture:**
```
Electron Frontend -> Main Backend (Orchestrator, localhost:8080) -> Local Agent (Claude Code)
                                                                 -> Remote Agent 1
                                                                 -> Remote Agent 2
```

**Connection pattern:** Electron IPC -> Orchestrator API -> Claude Code subprocesses (local + remote)

**Key features:**
- **@mention routing** — use @agent-name to direct tasks to specific agents
- Agents can run locally on different ports or remotely on other machines
- Orchestrator analyzes requests and creates execution plans
- No API key needed — uses Claude subscription via CLI auth

---

## 4. Gemini CLI UI Wrappers

### 4.1 Gemini CLI Desktop (Piebald-AI)

**Repository:** https://github.com/Piebald-AI/gemini-cli-desktop
**Stars:** ~300

**Architecture:**
- **Backend:** Rust with Tauri (desktop) and Rocket (web server)
- **Frontend:** React
- **Dual deployment:** Desktop app (AppImage/DMG/MSI) + web server (localhost:1858)

**Connection pattern:** Tauri IPC or HTTP -> Rust backend -> Gemini CLI subprocess

**Features:** Visual tool confirmation, real-time thought processes, code diff viewing, chat history management, file tree browser, file @-mentions, MCP server management.

**Also supports:** Qwen Code

---

### 4.2 Gemini-CLI-UI (cruzyjapan)

**Repository:** https://github.com/cruzyjapan/Gemini-CLI-UI
**Stars:** ~200

**Architecture:** React web frontend + WebSocket backend -> Gemini CLI subprocess

**Features:** Interactive chat, integrated terminal, file explorer, Git integration, session management.

---

### 4.3 Gemini CLI Web (ssdeanx)

**Repository:** https://github.com/ssdeanx/Gemini-CLI-Web
**Stars:** ~150

**Architecture:** React 18 + CodeMirror (with planned Monaco integration) + WebSocket backend

**Features:** CLI integration, chat, code editor, spec generation, dark/light mode.

---

### 4.4 Gemini Web Wrapper (Ven0m0)

**Repository:** https://github.com/Ven0m0/gemini-web-wrapper
**Stars:** ~100

**Architecture:** FastAPI backend + static HTML/JS frontend

**Note:** This uses the **Gemini API directly** (not the CLI), making it more of an API wrapper than a CLI wrapper.

---

## 5. Codex CLI UI Wrappers

### 5.1 OpenAI's Native Codex Web

**URL:** https://chatgpt.com/codex
**Documentation:** https://developers.openai.com/codex/

Codex has both a CLI and a web/cloud version:
- **Codex CLI** launches a full-screen terminal UI built in Rust
- **Codex Web** runs in the cloud at chatgpt.com/codex
- Environments can be shared between CLI and web via `codex cloud` + `Ctrl+O`

**Codex CLI's built-in TUI features:**
- Slash commands (`/review`, `/fork`, custom prompts)
- Model switching via `/model`
- Built-in Rust terminal UI (not web-based)

### 5.2 Happy (slopus/happy) — Also Supports Codex

Happy supports both Claude Code and Codex as backend agents, making it one of the few cross-tool mobile clients.

### 5.3 No Major Standalone Codex Web Wrappers

Unlike Claude Code, Codex CLI has fewer standalone web wrappers because:
1. OpenAI provides its own web version (chatgpt.com/codex)
2. Codex CLI has a rich built-in TUI
3. Multi-tool wrappers (AionUi, CCManager) cover the gap

---

## 6. Multi-Tool / Universal Agent UIs

### 6.1 AionUi (iOfficeAI)

**Repository:** https://github.com/iOfficeAI/AionUi
**Website:** https://aionui.site/
**Stars:** ~2,000

**Supported tools:** Gemini CLI, Claude Code, Codex, OpenCode, Qwen Code, Goose CLI, Auggie

**Architecture:**
- **Desktop app:** Electron-based
- **Data storage:** Local SQLite database (no cloud upload)
- **Agent integration:** ACP (Agent Communication Protocol) for unified CLI management
- **Multi-model support:** Official platforms (Gemini, Claude, OpenAI), cloud providers (AWS Bedrock), Chinese platforms (Qwen, Zhipu AI, Kimi), local models (Ollama, LM Studio)

**Key insight:** Like "Claude Cowork makes Claude Code easier to use, AionUi is the free, open-source Cowork platform for all your command-line AI tools." Solves: conversations can't be saved, single-session limitations, cumbersome file operations.

---

### 6.2 CCManager (kbwo)

**Repository:** https://github.com/kbwo/ccmanager
**Stars:** ~500

**Supported tools:** Claude Code, Gemini CLI, Codex CLI, Cursor Agent, Copilot CLI, Cline CLI, OpenCode, Kimi CLI

**Architecture:** Go-based TUI, similar to Claude Squad but multi-tool

**Key features:**
- **State hooks** — execute custom commands on session status changes
- **Worktree hooks** — automate dev environment setup on worktree creation
- **Auto-approval** — automatically approve safe prompts
- **Devcontainer support** — run agents in sandboxed containers
- **Multi-project** — manage multiple git repos from single interface

---

### 6.3 CC-Switch (farion1231)

**Repository:** https://github.com/farion1231/cc-switch
**Stars:** ~400

**Supported tools:** Claude Code, Codex, OpenCode, Gemini CLI

**Architecture:** Electron desktop app with local API proxy

**Key features:**
- **Local API proxy** with per-app takeover and automatic failover
- **Live config takeover** — backs up and redirects CLI live config to local proxy
- **Request logging and usage statistics** for debugging and cost tracking
- **Claude Rectifier** (thinking signature correction)
- Provider-specific configuration management
- MCP server management

**Install:** `brew tap farion1231/ccswitch && brew install --cask cc-switch`

---

## 7. General AI Agent UI Frameworks

### 7.1 Open WebUI

**Repository:** https://github.com/open-webui/open-webui
**Stars:** ~124,000

**Architecture:**
- **Backend:** FastAPI (Python, async)
- **Frontend:** SvelteKit
- **Database:** SQLite (optional encryption), PostgreSQL, or cloud storage (S3, GCS, Azure)
- **LLM backends:** Ollama, OpenAI-compatible APIs, built-in inference engine

**Agent capabilities:**
- **Pipelines Framework** — modular plugin system for custom logic
- **"Pipe" functions** — create custom models/agents within the UI
- **Channels** (Beta) — Discord/Slack-style chat rooms with AI bots
- Multi-agent approaches via community extensions

**Relevance to Agent Monitor:** Open WebUI is the gold standard for self-hosted AI chat UIs. Its Pipelines framework shows how to create extensible agent architectures. However, it's focused on API-based LLM access, not CLI tool management.

---

### 7.2 LobeChat / LobeHub

**Repository:** https://github.com/lobehub/lobehub
**Stars:** ~60,000+

**Architecture:**
- **Frontend:** Next.js + TypeScript
- **Providers:** OpenAI, Claude, Gemini, Ollama, Qwen, DeepSeek
- **Plugin system:** Agents Market + Plugin Market

**Multi-agent features:**
- "Agents as the unit of work"
- Multi-agent collaboration and team design
- Humans and agents co-evolve in shared workspace

**Architecture layers:** Frontend -> EdgeRuntime API -> Agents Market -> Plugin Market -> Independent plugins

---

### 7.3 Chatbot UI (mckaywrigley)

**Repository:** https://github.com/mckaywrigley/chatbot-ui
**Stars:** ~30,000+

**Architecture:** Next.js + TypeScript + Tailwind CSS + Supabase (PostgreSQL)

**Relevance:** Clean, proven architecture for OpenAI-style chat interfaces. Good reference for UI patterns but doesn't handle CLI agents.

---

### 7.4 OpenClaw

**Repository:** https://github.com/openclaw/openclaw
**Stars:** ~147,000

**Architecture:** Multi-platform personal AI assistant running on your own devices. Communicates via WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Microsoft Teams.

**Dashboard ecosystem:**
- **OpenClaw Mission Control** — centralized operations and governance platform
- **OpenClaw Dashboard** (tugcantopaloglu) — real-time monitoring with auth, TOTP MFA, cost tracking
- **OpenClaw Dashboard** (mudrii) — zero-dependency command center

**Note:** Peter Steinberger (creator) announced joining OpenAI on 2026-02-14; project moving to open-source foundation.

---

### 7.5 Superinterface

**Repository:** https://github.com/supercorp-ai/superinterface
**Website:** https://superinterface.ai/

**Architecture:** React components and hooks library for building AI assistants

**Integration methods:**
1. Script tag embed
2. React components
3. Dedicated webpage on custom subdomain

**Supported backends:** OpenAI, Anthropic, Groq, Mistral, Together.ai, Open Router, Perplexity

**Relevance:** Provides embeddable UI components (chat, voice chat, chat bubbles) that could be used as building blocks for Agent Monitor.

---

## 8. Terminal-in-Browser Approaches

### 8.1 xterm.js + node-pty (The Standard Stack)

**xterm.js:** https://github.com/xtermjs/xterm.js (16k+ stars)
**node-pty:** https://github.com/microsoft/node-pty (Microsoft)

**Architecture:**
```
Browser (xterm.js terminal emulator) <-> WebSocket <-> Node.js server (node-pty pseudoterminal) <-> Shell/CLI process
```

**How it works:**
1. `node-pty` spawns a shell instance as a pseudoterminal on the server
2. WebSocket connection relays stdin/stdout between browser and PTY
3. `xterm.js` renders terminal output with full ANSI support in the browser
4. Real-time bidirectional communication

**This is how you'd build a raw terminal wrapper for any CLI tool.** The advantage is complete fidelity — the web terminal behaves exactly like a real terminal, including colors, cursor movement, interactive prompts.

**Used by:** Wave Terminal, VS Code's integrated terminal, many cloud IDEs

### 8.2 Wave Terminal

**Repository:** https://github.com/wavetermdev/waveterm
**Website:** https://www.waveterm.dev/
**Stars:** ~10,000+

**Architecture:**
- **Shell:** Electron
- **Frontend:** React/TypeScript
- **Backend:** Go
- **AI features:** Context-aware terminal assistant, multi-model support (OpenAI, Claude, Azure, Perplexity, Ollama)

**Relevance:** Shows how to build an AI-native terminal with drag-and-drop blocks, inline rendering, and persistent sessions. Could serve as inspiration for Agent Monitor's terminal component.

---

## 9. Architecture Patterns Analysis

### Pattern 1: Claude Agent SDK (Subprocess Transport)

**Used by:** CloudCLI, claude-code-webui (sugyan), claude-agent-server (dzhng)

```
Your App -> Claude Agent SDK -> SubprocessCLITransport -> Claude Code CLI -> Anthropic API
```

**Details:**
- SDK spawns Claude Code CLI as a child process
- Communication via stdin/stdout using NDJSON
- SDK handles CLI discovery: bundled -> cli_path -> PATH -> common locations
- Version checking before spawn
- JSON reassembly state machine for stdout buffering
- `_write_lock` prevents concurrent stdin writes
- Bidirectional control protocol — both SDK and CLI can initiate requests

**Pros:**
- Official, supported integration path
- Handles streaming, tool permissions, session management
- Available in Python (`claude-code-sdk`) and TypeScript (`@anthropic-ai/claude-agent-sdk`)
- Well-documented message types and event system

**Cons:**
- Requires Claude Code CLI installed on the machine
- Subprocess management complexity (crashes, restarts, zombies)
- CLI discovery can be fragile across environments

---

### Pattern 2: Hidden `--sdk-url` WebSocket Protocol

**Used by:** The Companion, some experimental projects

```
Claude Code CLI --sdk-url ws://server:PORT -> WebSocket Server -> Web Frontend
```

**Details:**
- Undocumented flag hidden with `.hideHelp()` in Commander config
- Transforms CLI from interactive terminal to WebSocket client
- Emits NDJSON over WebSocket
- Full streaming with tool execution events

**Pros:**
- Direct, low-overhead connection
- Full access to all CLI events
- No SDK wrapper needed

**Cons:**
- **UNSUPPORTED** — Anthropic could remove it at any time
- No stability guarantees
- No documentation
- Security advisory: `GHSA-9f65-56v6-gxw7` — allows WebSocket connections from arbitrary origins

---

### Pattern 3: tmux Session Management

**Used by:** Claude Squad, CCManager, Agent-of-Empires, claude-tmux

```
Manager App -> tmux (create/attach/manage sessions) -> CLI process in tmux pane
            -> git worktree (code isolation per agent)
```

**Details:**
- Each agent gets its own tmux session
- Manager can read tmux pane content (capture-pane)
- Manager can send keystrokes to tmux panes (send-keys)
- Combined with git worktrees for code-level isolation
- Daemon process monitors sessions for prompt acceptance

**Pros:**
- Battle-tested (tmux is rock-solid)
- Works with ANY CLI tool (Claude Code, Codex, Aider, Gemini CLI, etc.)
- True process isolation
- Session persistence survives manager crashes
- Can be accessed directly via terminal for debugging

**Cons:**
- Requires tmux installed
- Reading/parsing tmux pane output is hacky
- No structured data format (must parse terminal output)
- Higher latency for UI updates
- Not web-native (needs adapter for web access)

---

### Pattern 4: Direct API (Bypass CLI)

**Used by:** Open WebUI, LobeChat, Chatbot UI, Gemini Web Wrapper (Ven0m0)

```
Web Frontend -> Backend Server -> AI Provider HTTP API (Anthropic, OpenAI, Google)
```

**Details:**
- Completely bypasses CLI tools
- Uses provider APIs directly (Messages API, Chat Completions, etc.)
- Streaming via SSE or WebSocket

**Pros:**
- Most reliable and well-documented approach
- Full control over request/response lifecycle
- No CLI dependencies
- Works anywhere (cloud, serverless, edge)

**Cons:**
- Loses all CLI-specific features (tool use, file system access, MCP, bash execution)
- Must reimplement agent loop, context management, tool permissions
- Not the same as running Claude Code — it's just an API wrapper
- **Fundamentally different from managing CLI agents**

---

### Pattern 5: PTY-based (node-pty / pseudoterminal)

**Used by:** vultuk/claude-code-web, terminal-in-browser approaches

```
Web Frontend (xterm.js) <-> WebSocket <-> Node.js (node-pty) <-> CLI process
```

**Details:**
- Spawns CLI in a pseudoterminal
- Full terminal emulation including ANSI codes, colors, cursor
- Bidirectional stdin/stdout relay via WebSocket

**Pros:**
- Complete terminal fidelity
- Works with any CLI tool
- User sees exactly what they'd see in a terminal
- Handles interactive prompts naturally

**Cons:**
- Must parse ANSI escape codes for structured data extraction
- Harder to build rich UI on top of raw terminal output
- node-pty has native dependencies (compilation required)
- Higher bandwidth than structured data

---

### Pattern 6: Encrypted Relay

**Used by:** Happy (slopus)

```
Local CLI <-> Encrypted WebSocket <-> Relay Server (zero-knowledge) <-> Mobile/Web Client
```

**Details:**
- QR code establishes shared encryption secret
- All messages encrypted before leaving local machine
- Relay server handles only encrypted blobs
- Bidirectional sync between devices

**Pros:**
- Access agents from anywhere (mobile, different network)
- Privacy-first (server sees nothing)
- No port forwarding or VPN needed
- Cross-device session continuity

**Cons:**
- Added latency through relay
- Encryption overhead
- Relay server dependency (single point of failure for availability)
- Complex setup vs direct connection

---

## 10. Key Technical Approaches Categorized

### SDK-based (Embed AI tool's SDK directly)
| Project | SDK Used |
|---------|----------|
| CloudCLI | Claude Agent SDK |
| claude-code-webui (sugyan) | Claude Code SDK |
| claude-agent-server (dzhng) | Claude Agent SDK |
| CUI (wbopan) | Claude Code subprocess |

### CLI Subprocess (Spawn as child process, pipe stdin/stdout)
| Project | CLI Tool |
|---------|----------|
| Happy (slopus) | Claude Code, Codex |
| claude-code-web (vultuk) | Claude Code |
| claude-code-web (sunpix) | Claude Code |
| Gemini-CLI-UI | Gemini CLI |
| All SDK-based projects | (SDK wraps subprocess internally) |

### tmux-based (Manage sessions via tmux)
| Project | Language |
|---------|----------|
| Claude Squad | Go |
| CCManager | Go |
| Agent-of-Empires | Unknown |
| claude-tmux (nielsgroen) | Unknown |
| claunch (0xkaz) | Unknown |

### PTY-based (Pseudoterminal with node-pty)
| Project | Stack |
|---------|-------|
| claude-code-web (vultuk) | Express + WebSocket |
| Wave Terminal | Electron + Go |
| Various xterm.js-based | Node.js + WebSocket |

### API-based (Use HTTP API directly, bypass CLI)
| Project | APIs |
|---------|------|
| Open WebUI | Ollama, OpenAI-compatible |
| LobeChat | OpenAI, Claude, Gemini, etc. |
| Chatbot UI | OpenAI |
| Gemini Web Wrapper | Gemini API |

### Hybrid (Combination of approaches)
| Project | Approaches Combined |
|---------|---------------------|
| AionUi | ACP protocol + Electron + SQLite + CLI subprocess |
| CC-Switch | Local API proxy + CLI config takeover + Electron |
| Claude Flow | MCP protocol + subprocess + WebSocket + swarm |
| The Companion | `--sdk-url` WebSocket + React frontend |
| Claude Code by Agents | Electron IPC + orchestrator API + subprocess |

---

## 11. Connection Pattern Code Snippets

### Claude Agent SDK (TypeScript) — Subprocess Spawn

```typescript
// Official Claude Agent SDK approach
import { ClaudeCode } from '@anthropic-ai/claude-agent-sdk';

const claude = new ClaudeCode();

// The SDK spawns Claude Code CLI as a subprocess internally
// SubprocessCLITransport handles: CLI discovery, version check, spawn, NDJSON streaming
const response = await claude.query({
  prompt: "Refactor the authentication module",
  workingDirectory: "/path/to/project",
  // Custom spawn function for advanced control:
  spawnClaudeCodeProcess: (args) => {
    return spawn('claude', args, { cwd: '/path/to/project' });
  }
});

// Streaming with events
for await (const event of claude.stream({ prompt: "..." })) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.content);
      break;
    case 'tool_use':
      console.log(`Tool: ${event.name}`, event.input);
      break;
  }
}
```

### Claude Agent SDK (Python) — Subprocess Transport

```python
# Official Claude Agent SDK Python approach
from claude_code_sdk import ClaudeCode, ClaudeCodeOptions

# SDK uses SubprocessCLITransport internally
# Discovery order: bundled -> cli_path -> PATH -> common locations
async with ClaudeCode() as claude:
    response = await claude.query(
        prompt="Fix the failing tests",
        options=ClaudeCodeOptions(
            working_directory="/path/to/project",
            max_turns=10
        )
    )

    # Streaming
    async for event in claude.stream(prompt="..."):
        if event.type == "text":
            print(event.content, end="")
        elif event.type == "tool_use":
            print(f"Using tool: {event.name}")
```

### SSE Streaming (claude-code-webui pattern)

```typescript
// Server-side (Hono)
app.get('/api/stream', async (c) => {
  return streamSSE(c, async (stream) => {
    const claudeProcess = spawn('claude', ['--output-format', 'stream-json']);

    claudeProcess.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          const event = JSON.parse(line);
          stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event)
          });
        }
      }
    });
  });
});

// Client-side (React hook)
function useClaudeStreaming(url: string) {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    const eventSource = new EventSource(url);
    eventSource.addEventListener('text', (e) => {
      const data = JSON.parse(e.data);
      setMessages(prev => [...prev, data]);
    });
    return () => eventSource.close();
  }, [url]);

  return messages;
}
```

### WebSocket + node-pty (Terminal Bridge)

```typescript
// Server-side
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  const shell = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.env.HOME,
  });

  shell.onData((data: string) => {
    ws.send(JSON.stringify({ type: 'output', data }));
  });

  ws.on('message', (msg: string) => {
    const { type, data } = JSON.parse(msg);
    if (type === 'input') {
      shell.write(data);
    } else if (type === 'resize') {
      shell.resize(data.cols, data.rows);
    }
  });

  ws.on('close', () => shell.kill());
});

// Client-side (xterm.js)
import { Terminal } from 'xterm';

const term = new Terminal();
term.open(document.getElementById('terminal'));

const ws = new WebSocket('ws://localhost:8080');
ws.onmessage = (event) => {
  const { type, data } = JSON.parse(event.data);
  if (type === 'output') term.write(data);
};

term.onData((data) => {
  ws.send(JSON.stringify({ type: 'input', data }));
});
```

### tmux Session Management (Go pattern from Claude Squad)

```go
// Simplified from Claude Squad's architecture

type TmuxSession struct {
    Name    string
    Dir     string
    Command string
}

func (s *TmuxSession) Create() error {
    // Create new tmux session in detached mode
    cmd := exec.Command("tmux", "new-session", "-d", "-s", s.Name, "-c", s.Dir)
    return cmd.Run()
}

func (s *TmuxSession) SendCommand(command string) error {
    // Send keystrokes to tmux pane
    cmd := exec.Command("tmux", "send-keys", "-t", s.Name, command, "Enter")
    return cmd.Run()
}

func (s *TmuxSession) CaptureOutput() (string, error) {
    // Read current pane content
    cmd := exec.Command("tmux", "capture-pane", "-t", s.Name, "-p")
    output, err := cmd.Output()
    return string(output), err
}

// Git worktree for code isolation
type GitWorktree struct {
    RepoPath string
    Branch   string
}

func (w *GitWorktree) Create() error {
    worktreePath := filepath.Join(w.RepoPath, ".worktrees", w.Branch)
    cmd := exec.Command("git", "worktree", "add", worktreePath, "-b", w.Branch)
    cmd.Dir = w.RepoPath
    return cmd.Run()
}
```

### Encrypted Relay (Happy pattern)

```typescript
// Simplified architecture concept

// CLI Side (happy-cli)
class HappyCLI {
  private ws: WebSocket;
  private encryptionKey: CryptoKey;  // Derived from QR code shared secret

  async connect(relayUrl: string, sharedSecret: string) {
    this.encryptionKey = await deriveKey(sharedSecret);
    this.ws = new WebSocket(relayUrl);
  }

  async sendMessage(plaintext: string) {
    const encrypted = await encrypt(plaintext, this.encryptionKey);
    this.ws.send(JSON.stringify({ type: 'message', data: encrypted }));
  }

  // Claude Code subprocess
  private claudeProcess = spawn('claude', ['--output-format', 'stream-json']);
}

// Relay Server (happy-server) — zero knowledge
class RelayServer {
  handleMessage(from: string, encryptedBlob: Buffer) {
    // Simply forward encrypted blob to the other endpoint
    // Server CANNOT read the content
    this.forward(from, encryptedBlob);
  }
}

// Mobile Client (happy-app)
class HappyApp {
  // Same encryption key from QR code scan
  async decryptAndDisplay(encryptedBlob: Buffer) {
    const plaintext = await decrypt(encryptedBlob, this.encryptionKey);
    this.renderMessage(plaintext);
  }
}
```

---

## 12. Protocols and Standards

### 12.1 AG-UI Protocol (Agent-User Interaction Protocol)

**Repository:** https://github.com/ag-ui-protocol/ag-ui
**By:** CopilotKit
**Website:** https://docs.ag-ui.com/

**What it is:** An open, lightweight, event-based protocol that defines how agents, users, and applications stay in sync. While MCP handles agent-to-tool context and A2A handles agent-to-agent coordination, AG-UI handles the **agent-to-frontend** layer.

**17 core event types** including:
- `TextMessageContent` — streaming text from agent
- `ToolCallStart` / `ToolCallEnd` — tool execution lifecycle
- State sync events, lifecycle events

**Supported frameworks:** LangGraph, CrewAI, AutoGen (AG2), Pydantic AI, and others

**Relevance to Agent Monitor:** This is the closest thing to a standard protocol for connecting agent backends to frontend UIs. Worth adopting or being compatible with.

### 12.2 A2UI (Agent-to-UI)

**By:** Google
**Website:** https://a2ui.org/

An open-source format optimized for representing updateable, agent-generated UIs. Designed for interoperable, cross-platform, generative or template-based UI responses from agents.

### 12.3 MCP (Model Context Protocol)

**By:** Anthropic

The standard for agent-to-tool communication. Claude Flow uses it heavily (87 MCP tools). Increasingly universal — adopted by Claude Code, Gemini CLI, VS Code extensions, and many others.

### 12.4 ACP (Agent Communication Protocol)

**Used by:** AionUi

Protocol for integrating external CLI tools into a unified interface. Less documentation available than MCP or AG-UI.

---

## 13. Recommendations

### For Agent Monitor: Which Patterns Are Most Stable and Production-Ready?

#### Tier 1: Recommended Approaches

**1. Claude Agent SDK (TypeScript) + SSE Streaming**
- **Stability:** High (official, maintained by Anthropic)
- **Best for:** Claude Code integration
- **Architecture:** Node.js backend wraps Claude Agent SDK, SSE streams to React frontend
- **Reference implementations:** claude-code-webui (sugyan), CloudCLI
- **Risk:** Low — this is the blessed path

**2. tmux + git worktree for Multi-Agent Isolation**
- **Stability:** Very High (tmux is battle-tested infrastructure)
- **Best for:** Running multiple agents concurrently with code isolation
- **Architecture:** Server manages tmux sessions, web UI shows status and output
- **Reference implementations:** Claude Squad (5.6k stars, very active)
- **Risk:** Low — tmux has been stable for decades
- **Caveat:** Need adapter layer to bridge tmux output to structured web data

**3. xterm.js + node-pty for Raw Terminal Access**
- **Stability:** High (Microsoft maintains node-pty, xterm.js is widely used)
- **Best for:** Providing full terminal experience in browser
- **Architecture:** WebSocket bridge between xterm.js and node-pty
- **Reference implementations:** Wave Terminal, VS Code terminal
- **Risk:** Low — mature stack, well-documented

#### Tier 2: Good Alternatives

**4. Hybrid: SDK for Claude Code + CLI subprocess for others**
- Use Claude Agent SDK for Claude Code (structured data)
- Use node-pty subprocess for Gemini CLI and Codex CLI (terminal emulation)
- Unified web frontend renders both structured and terminal output
- **This is likely the best approach for Agent Monitor** since it handles multiple CLI tools

**5. Encrypted Relay for Remote Access**
- Good if mobile/remote access is needed
- Happy's approach is proven and privacy-respecting
- Can layer on top of any local connection method

#### Tier 3: Experimental / Risky

**6. `--sdk-url` WebSocket Protocol**
- High reward (clean, direct connection) but **unsupported**
- Anthropic could remove it at any time
- Security advisory already issued
- NOT recommended for production

**7. Claude Flow's MCP Swarm Orchestration**
- Ambitious and feature-rich, but complex
- "Ranked #1 in agent-based frameworks" claim — evaluate independently
- Good for inspiration, risky as a dependency

### Recommended Architecture for Agent Monitor

```
[Browser Client]
  |
  |-- React + xterm.js (terminal view) + Rich UI (structured view)
  |
  v
[Agent Monitor Server] (Node.js/Bun)
  |
  |-- SSE/WebSocket to browser
  |
  |-- Claude Code: via Claude Agent SDK (TypeScript)
  |   -> SubprocessCLITransport -> NDJSON streaming
  |
  |-- Gemini CLI: via node-pty subprocess
  |   -> PTY output -> parse/stream to frontend
  |
  |-- Codex CLI: via node-pty subprocess
  |   -> PTY output -> parse/stream to frontend
  |
  |-- Session Management: tmux sessions + git worktrees
  |   -> Each agent gets isolated tmux session
  |   -> Code changes on separate branches
  |
  |-- Data: SQLite (session history, agent state)
```

### Key Design Decisions

1. **Use Claude Agent SDK for Claude Code** — structured data, streaming, tool permissions
2. **Use node-pty for Gemini/Codex CLIs** — full terminal emulation, works with any CLI
3. **Use tmux for process isolation** — proven, crash-resistant, debuggable
4. **Use git worktrees for code isolation** — agents can't interfere with each other
5. **Use SSE for real-time streaming** — simpler than WebSocket for server->client
6. **Use WebSocket for bidirectional terminal I/O** — needed for interactive CLI input
7. **Use SQLite for persistence** — sessions, history, agent state (proven by AionUi, Claudia)
8. **Build AG-UI protocol compatibility** — future-proof the frontend interface

---

## 14. Links and References

### Claude Code UI Projects
- Happy: https://github.com/slopus/happy | https://happy.engineering/
- CloudCLI: https://github.com/siteboon/claudecodeui
- CUI: https://github.com/wbopan/cui
- claude-code-webui (sugyan): https://github.com/sugyan/claude-code-webui
- claude-code-web (vultuk): https://github.com/vultuk/claude-code-web
- The Companion: https://github.com/The-Vibe-Company/companion
- Claudia/Opcode: https://github.com/marcusbey/claudia | https://claudiacode.com/
- claude-code-web (sunpix): https://github.com/sunpix/claude-code-web
- Claude Code by Agents: https://github.com/baryhuang/claude-code-by-agents
- claude-agent-server: https://github.com/dzhng/claude-agent-server

### Multi-Agent Managers
- Claude Squad: https://github.com/smtg-ai/claude-squad
- Claude Flow: https://github.com/ruvnet/claude-flow
- CCManager: https://github.com/kbwo/ccmanager
- claude-tmux: https://github.com/nielsgroen/claude-tmux

### Gemini CLI UI Projects
- Gemini CLI Desktop: https://github.com/Piebald-AI/gemini-cli-desktop
- Gemini-CLI-UI: https://github.com/cruzyjapan/Gemini-CLI-UI
- Gemini CLI Web: https://github.com/ssdeanx/Gemini-CLI-Web
- Gemini Web Wrapper: https://github.com/Ven0m0/gemini-web-wrapper

### Multi-Tool UIs
- AionUi: https://github.com/iOfficeAI/AionUi
- CC-Switch: https://github.com/farion1231/cc-switch

### General AI UIs
- Open WebUI: https://github.com/open-webui/open-webui
- LobeChat: https://github.com/lobehub/lobehub
- Chatbot UI: https://github.com/mckaywrigley/chatbot-ui
- OpenClaw: https://github.com/openclaw/openclaw
- Superinterface: https://github.com/supercorp-ai/superinterface
- Wave Terminal: https://github.com/wavetermdev/waveterm

### Protocols & Standards
- AG-UI Protocol: https://github.com/ag-ui-protocol/ag-ui | https://docs.ag-ui.com/
- A2UI (Google): https://a2ui.org/
- MCP (Model Context Protocol): https://modelcontextprotocol.io/

### SDK & Documentation
- Claude Agent SDK (Python): https://github.com/anthropics/claude-agent-sdk-python
- Claude Agent SDK (TypeScript): https://github.com/anthropics/claude-agent-sdk-typescript
- Claude Code SDK docs: https://platform.claude.com/docs/en/agent-sdk/overview
- Codex CLI docs: https://developers.openai.com/codex/cli/
- Gemini CLI docs: https://geminicli.com/docs/

### Core Libraries
- xterm.js: https://github.com/xtermjs/xterm.js
- node-pty: https://github.com/microsoft/node-pty
- bubbletea (TUI framework): https://github.com/charmbracelet/bubbletea

### Curated Lists
- awesome-claude-code (jqueryscript): https://github.com/jqueryscript/awesome-claude-code
- awesome-claude-code (hesreallyhim): https://github.com/hesreallyhim/awesome-claude-code
- awesome-gemini-cli (Piebald-AI): https://github.com/Piebald-AI/awesome-gemini-cli

### Articles & Deep Dives
- `--sdk-url` discovery: https://medium.com/@CodePulse/i-found-a-hidden-flag-in-claude-codes-cli-here-s-what-happened-next-14b90050a986
- Claude Code internals SSE processing: https://kotrotsos.medium.com/claude-code-internals-part-7-sse-stream-processing-c620ae9d64a1
- How Claude Code is built: https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built
- Claude Code Swarms (Addy Osmani): https://addyosmani.com/blog/claude-code-agent-teams/
- Claude Agent SDK instrumentation: https://laminar.sh/blog/2025-12-03-claude-agent-sdk-instrumentation

---

*Research conducted 2026-02-17. Star counts and activity levels are approximate and change frequently.*
