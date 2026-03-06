<!-- README HERO BANNER -->
<p align="center">
  <img src="public/hero-banner.png" alt="Agendo - AI Agent Manager & Builder" width="100%">
</p>

# Agendo

> **Manage, orchestrate, and collaborate with AI coding agents (Claude, Codex, Gemini) from a single dashboard.**

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js" alt="Next.js">
  <img src="https://img.shields.io/badge/React-19-blue?style=for-the-badge&logo=react" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/PostgreSQL-Drizzle-336791?style=for-the-badge&logo=postgresql" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/MCP-Integrated-green?style=for-the-badge" alt="MCP">
</p>

---

## Quick Start (Self-Hosted)

### Prerequisites

- **Node.js 22+** and **pnpm 10+**
- **Docker** (for PostgreSQL) or a running PostgreSQL 15+ instance
- **PM2** (`npm install -g pm2`) — for production; optional for dev
- At least one AI CLI installed and authenticated: `claude`, `codex`, or `gemini`

### Setup

```bash
# 1. Clone and install
git clone https://github.com/NehoraiHadad/agendo.git
cd agendo
pnpm install

# 2. Start PostgreSQL
docker compose up -d

# 3. Configure environment
cp .env.example .env.local
# Edit .env.local — set JWT_SECRET (generate with: openssl rand -hex 32)

# 4. Build everything
pnpm build && pnpm worker:build && pnpm build:mcp

# 5. Set up the database
pnpm db:migrate
pnpm db:seed          # seeds config + auto-discovers agents in PATH

# 6. Start with PM2
cp ecosystem.config.example.js ecosystem.config.js
pm2 start ecosystem.config.js
pm2 save

# 7. Open
open http://localhost:4100
```

### Development mode (without PM2)

```bash
# Terminal 1 — Next.js app
pnpm dev

# Terminal 2 — Worker (hot-reload)
pnpm worker:dev

# Terminal 3 — Terminal server (optional)
pnpm tsx src/terminal/server.ts
```

### Remote access with Tailscale

For accessing Agendo from your phone or other devices, install [Tailscale](https://tailscale.com) on both machines. Agendo is then available at `http://<machine-name>:4100` over your private network. No reverse proxy or SSL config needed.

---

## What is Agendo?

Agendo is a self-hosted dashboard for managing AI coding agents. It provides:

- **Agent discovery** — auto-detects Claude, Codex, and Gemini CLIs from your PATH
- **Kanban task management** — organize work, assign to agents, track progress
- **Live sessions** — bidirectional chat with agents, real-time log streaming
- **MCP integration** — agents can create tasks, check status, and spawn sub-agents autonomously
- **Multi-agent orchestration** — coordinate multiple agents across projects
- **Built-in terminal** — xterm.js terminal with node-pty, directly in the browser
- **PWA support** — installable on mobile, push notifications when agents need input

## Architecture

Agendo runs as three cooperating processes:

```
Next.js App (port 4100)
  API routes, Kanban UI, SSE endpoints, MCP server host
       |
       | pg-boss queues + PG NOTIFY
       v
Worker (agendo-worker)
  Dequeues jobs, spawns AI CLI subprocesses, streams events
       |
       | stdio transport
       v
MCP Server (dist/mcp-server.js)
  Injected into agent sessions, exposes task management tools
```

### PM2 Services

| Service         | Port   | PM2 Name          | Description                        |
| --------------- | ------ | ----------------- | ---------------------------------- |
| Next.js App     | `4100` | `agendo`          | Web UI, API, SSE, MCP server host  |
| Worker          | —      | `agendo-worker`   | Job queue processor, agent spawner |
| Terminal Server | `4101` | `agendo-terminal` | xterm.js + node-pty over socket.io |

### Restarting safely

```bash
# Worker — always safe to restart
pm2 restart agendo-worker

# Next.js — use the safe script (waits for active sessions to finish)
./scripts/safe-restart-agendo.sh

# Force restart (only when no sessions are active)
./scripts/safe-restart-agendo.sh --force
```

## Tech Stack

- **Framework**: Next.js 16 (App Router, React 19, TypeScript strict)
- **Database**: PostgreSQL + Drizzle ORM
- **Queue**: pg-boss v10
- **UI**: shadcn/ui + Tailwind CSS v4
- **State**: Zustand (client), Server Components (server)
- **Real-time**: SSE (board updates, log streaming), PG NOTIFY (worker-frontend bridge)
- **Terminal**: xterm.js v6 + node-pty + socket.io
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)

## Environment Variables

Copy `.env.example` to `.env.local`. Required:

| Variable       | Description                         |
| -------------- | ----------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string        |
| `JWT_SECRET`   | Min 16 chars for API authentication |

All other variables have sensible defaults. See `.env.example` for the full list.

## Scripts

```bash
# Development
pnpm dev                # Next.js dev server (port 4100)
pnpm worker:dev         # Worker with hot-reload

# Build
pnpm build              # Next.js production build
pnpm worker:build       # Worker (esbuild)
pnpm build:mcp          # MCP server bundle

# Database
pnpm db:migrate         # Apply migrations
pnpm db:seed            # Seed config + discover agents
pnpm db:studio          # Open Drizzle Studio

# Quality
pnpm lint               # ESLint (zero warnings)
pnpm typecheck          # TypeScript strict check
pnpm test               # Vitest
```

## Agent CLI Setup

Agendo auto-discovers agents from your PATH during `pnpm db:seed`. Install and authenticate the ones you want to use:

### Claude (Anthropic)

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Codex (OpenAI)

```bash
npm install -g @openai/codex
# Set OPENAI_API_KEY in your environment
```

### Gemini (Google)

```bash
npm install -g @anthropic-ai/claude-code   # placeholder — check Google's docs
gemini auth login
```

After installing new CLIs, run `pnpm db:seed` again to register them.

## Project Structure

```
src/
  app/              # Next.js App Router (pages, API routes, SSE endpoints)
  components/       # React components (sessions, kanban, terminal, etc.)
  hooks/            # Custom React hooks
  lib/
    db/             # Drizzle schema, migrations, seed
    discovery/      # Agent auto-discovery from PATH
    mcp/            # MCP server + config templates
    services/       # Business logic (tasks, sessions, agents, projects)
    worker/         # Worker entry, adapters per agent CLI
      adapters/     # Claude, Codex, Gemini protocol adapters
  terminal/         # Terminal server (socket.io + node-pty)
scripts/            # Utility scripts (safe restart, log reader, etc.)
planning/           # Architecture docs, data model, phase plans
drizzle/            # SQL migration files
```

## License

MIT
