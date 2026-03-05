# Self-Hosted Deployment Proposal

**Status**: Draft for review
**Date**: 2026-03-05

## Executive Summary

Agendo can be made self-hostable with **native-first deployment** (setup script + docs), with Docker Compose only for PostgreSQL. Full containerization is impractical because agent CLIs need host-level access (auth, config dirs, project files, PTY). The work breaks into: (1) decouple hardcoded paths, (2) create `.env.example` + `ecosystem.config.example.js`, (3) write a setup script, (4) improve the seed to bootstrap agents/capabilities, (5) write deployment docs.

---

## Current State Audit

### What a fresh install requires today

1. **System deps**: Node.js 22+, pnpm 10+, PM2, PostgreSQL 15+
2. **Agent CLIs**: `claude`, `codex`, `gemini` (each installed + authenticated separately)
3. **pnpm install** (includes native `node-pty` compilation — needs build tools)
4. **Three build steps**: `pnpm build`, `pnpm worker:build`, `pnpm build:mcp`
5. **Database**: create DB, run `pnpm db:migrate`, run `pnpm db:seed`
6. **Environment**: `.env.local` for Next.js, `ecosystem.config.js` for PM2/worker
7. **Directories**: `LOG_DIR` must exist (`/data/agendo/logs` default)
8. **PM2 start**: `pm2 start ecosystem.config.js --only agendo,agendo-worker,agendo-terminal`
9. **Agent discovery**: agents auto-discovered from PATH — but no agents/capabilities in DB until user creates them manually or the seed does it

### Hardcoded assumptions that break

| Location                                        | What's hardcoded                                       | Fix                                                                |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `config.ts:11`                                  | `LOG_DIR` default → `/data/agendo/logs`                | Change default to `./logs` (relative to project)                   |
| `config.ts:14`                                  | `ALLOWED_WORKING_DIRS` → `/home/ubuntu/projects:/tmp`  | Change default to `$HOME/projects:/tmp` or remove default entirely |
| `ecosystem.config.js:1`                         | Absolute pnpm path                                     | Ship `ecosystem.config.example.js` with `pnpm` (no path)           |
| `ecosystem.config.js:53-106`                    | All CWDs → `/home/ubuntu/projects/agendo`              | Template uses `__dirname` or env var                               |
| `ecosystem.config.js:72`                        | DATABASE_URL with hardcoded IP + creds                 | Read from `.env` or use `dotenv` in config                         |
| `ecosystem.config.js:77-85`                     | LOG_DIR, MCP_SERVER_PATH, VAPID keys                   | All from `.env`                                                    |
| `api/mcp/config/route.ts:36`                    | MCP path fallback → `/home/ubuntu/projects/agendo/...` | Use `path.resolve('dist/mcp-server.js')`                           |
| `api/projects/discover/route.ts:79`             | `extraRoots` → `/home/ubuntu`, `/home/ubuntu/projects` | Derive from `$HOME` + `ALLOWED_WORKING_DIRS`                       |
| `project-create-dialog.tsx:96`                  | Suggested path → `/home/ubuntu/projects/{slug}`        | Use `$HOME/projects/{slug}` (fetch from API)                       |
| `api/system-stats/route.ts:4`                   | `MONITOR_URL` → `http://localhost:9876`                | Make env var or disable gracefully when not available              |
| `session-plan-utils.ts:26`                      | `HOME` fallback → `/home/ubuntu`                       | Use `/root` or just require `HOME` to be set                       |
| Test files (safety.test.ts, decode-dir.test.ts) | `/home/ubuntu` in test fixtures                        | Use `os.homedir()` or keep as-is (tests are internal)              |

### Seed is too minimal

Current seed (`src/lib/db/seed.ts`) only creates `worker_config` entries. A new user gets an empty system — no agents, no capabilities, no projects. They'd need to:

1. Run agent discovery manually (or it auto-runs?)
2. Create capabilities manually via API
3. Create a project manually via UI

**Needed**: Seed that creates the three built-in agents (claude, codex, gemini) with their default capabilities, so the system is usable immediately after setup.

---

## Deployment Model Recommendation

### Native-first with Docker PostgreSQL

**Why not full Docker Compose?**

1. **Agent CLIs need host access**: `claude`, `codex`, `gemini` need access to `~/.claude/`, `~/.codex/`, `~/.gemini/` config dirs, the user's project files, and authenticated sessions. Mounting all of these into a container is fragile and defeats the purpose.
2. **node-pty needs PTY access**: Works in Docker but needs `--privileged` or `/dev/ptmx` access, adding complexity.
3. **PM2 inside Docker is an anti-pattern**: Docker already manages process lifecycle. Running PM2 inside means two process managers fighting.
4. **Agent auth flows**: Each CLI has its own auth (OAuth, API keys). Running `claude auth` inside a container that maps `~/.claude` is awkward.
5. **Working directory mismatch**: Agents modify files on the host filesystem. Container-mounted paths create confusion with file watching, git operations, etc.

**Docker for PostgreSQL only**: Most developers don't have PostgreSQL installed locally. A `docker-compose.yml` that runs just Postgres is genuinely helpful and simple.

### The recommended stack

```
User's machine (Mac/Linux)
├── PostgreSQL (Docker Compose — one container)
├── agendo (PM2 — Next.js app, port 4100)
├── agendo-worker (PM2 — background worker)
├── agendo-terminal (PM2 — terminal server, port 4101)
└── Agent CLIs (installed natively, in PATH)
    ├── claude (Anthropic CLI)
    ├── codex (OpenAI CLI)
    └── gemini (Google CLI)
```

### Alternative: no PM2 for simple setups

For local dev/personal use, PM2 might be overkill. Consider also supporting:

```bash
# Terminal 1
pnpm dev          # Next.js on :4100

# Terminal 2
pnpm worker:dev   # Worker with hot-reload

# Terminal 3 (optional)
pnpm terminal:dev # Terminal server on :4101
```

The setup script could offer both modes: PM2 (recommended for always-on servers) or manual (simpler for local laptops).

---

## What Needs to Change (Priority Order)

### P0: Must-have for public release

#### 1. Create `.env.example` with full documentation

All env vars with descriptions, example values, and which are required vs optional.

```env
# === Required ===
DATABASE_URL=postgresql://agendo:agendo@localhost:5432/agendo
JWT_SECRET=  # min 16 chars — generate with: openssl rand -hex 32

# === Optional (with sensible defaults) ===
PORT=4100
TERMINAL_WS_PORT=4101
LOG_DIR=./logs
ALLOWED_WORKING_DIRS=$HOME/projects:/tmp
MCP_SERVER_PATH=./dist/mcp-server.js
# ... etc
```

#### 2. Fix hardcoded path defaults in `config.ts`

- `LOG_DIR`: `/data/agendo/logs` → `./logs` (relative to project root)
- `ALLOWED_WORKING_DIRS`: `/home/ubuntu/projects:/tmp` → `$HOME/projects:/tmp` (resolved at runtime)

#### 3. Ship `ecosystem.config.example.js` (agendo-only)

Strip out story-creator, storybook, freckle. Use `process.cwd()` or `__dirname`. Read secrets from `.env` via dotenv or `process.env`.

```js
const path = require('path');
const ROOT = __dirname; // assumes config is in agendo root

module.exports = {
  apps: [
    {
      name: 'agendo',
      cwd: ROOT,
      script: 'pnpm',
      args: 'start', // or 'dev' for development
      interpreter: 'none',
      env: {
        PORT: process.env.PORT || '4100',
        NODE_OPTIONS: '--max-old-space-size=1024',
      },
    },
    {
      name: 'agendo-worker',
      cwd: ROOT,
      script: 'node',
      args: 'dist/worker/index.js',
      // Worker reads .env automatically or gets env from here
    },
    {
      name: 'agendo-terminal',
      cwd: ROOT,
      script: 'pnpm',
      args: 'tsx src/terminal/server.ts',
      interpreter: 'none',
    },
  ],
};
```

#### 4. Docker Compose for PostgreSQL

Minimal `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: agendo
      POSTGRES_PASSWORD: agendo
      POSTGRES_DB: agendo
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

#### 5. Enhance seed script

Expand `pnpm db:seed` to also:

- Run agent discovery (scan PATH for claude/codex/gemini)
- Create default capabilities for each discovered agent
- Print what was found/created

This way `pnpm db:seed` takes the system from empty DB to "ready to use."

#### 6. Setup script (`scripts/setup.sh`)

Interactive script that:

1. Checks prerequisites (node, pnpm, docker)
2. Copies `.env.example` → `.env.local` if missing
3. Generates `JWT_SECRET` if not set
4. Creates `LOG_DIR` if missing
5. Starts PostgreSQL via docker-compose
6. Runs `pnpm install`
7. Runs builds (next, worker, mcp)
8. Runs `pnpm db:migrate && pnpm db:seed`
9. Optionally sets up PM2
10. Prints "Agendo is running at http://localhost:4100"

#### 7. Fix remaining hardcoded references

- `api/mcp/config/route.ts:36` — use `path.resolve(config.MCP_SERVER_PATH ?? 'dist/mcp-server.js')`
- `api/projects/discover/route.ts:79` — derive from `os.homedir()` + `ALLOWED_WORKING_DIRS`
- `project-create-dialog.tsx:96` — fetch home dir from API or use a configurable base
- `api/system-stats/route.ts:4` — make `MONITOR_URL` an env var, gracefully handle absence
- `session-plan-utils.ts:26` — use `os.homedir()` instead of hardcoded fallback

### P1: Nice-to-have

#### 8. Onboarding UI

First-visit wizard that detects:

- Which agent CLIs are installed
- Whether they're authenticated
- Guides creating a first project

#### 9. VAPID key generation script

```bash
pnpm tsx scripts/generate-vapid-keys.ts
# Outputs keys to paste into .env.local
```

#### 10. Health check endpoint

`GET /api/health` that reports: DB connected, worker running, which agents available.

#### 11. `README.md` rewrite

Quick-start section at the top with copy-pasteable commands.

---

## Minimum Steps: Git Clone to Running Instance

### Target: 8 steps

```bash
# 1. Clone
git clone https://github.com/NehoraiHadad/agendo.git && cd agendo

# 2. Install
pnpm install

# 3. Start PostgreSQL
docker compose up -d

# 4. Configure
cp .env.example .env.local
# Edit .env.local: set JWT_SECRET (or run setup script to auto-generate)

# 5. Build
pnpm build && pnpm worker:build && pnpm build:mcp

# 6. Migrate & seed
pnpm db:migrate && pnpm db:seed

# 7. Start
pm2 start ecosystem.config.js
# OR: pnpm dev (terminal 1) + pnpm worker:dev (terminal 2)

# 8. Open
open http://localhost:4100
```

### With setup script: 4 steps

```bash
git clone https://github.com/NehoraiHadad/agendo.git && cd agendo
pnpm install
./scripts/setup.sh    # interactive: generates secrets, starts DB, builds, migrates, seeds
pm2 start ecosystem.config.js   # or: scripts suggest this
```

---

## Tailscale Note

For remote access (phone, tablet, other machines), users install Tailscale on both the server and client. Agendo is then accessible at `http://machine-name:4100` over the Tailscale network. For HTTPS, Tailscale Funnel or `tailscale cert` can be used. No reverse proxy needed.

The setup guide should include a short "Remote access with Tailscale" section explaining this.

---

## Implementation Order

| Step                              | Effort | Impact    | Depends on |
| --------------------------------- | ------ | --------- | ---------- |
| 1. `.env.example`                 | Small  | High      | —          |
| 2. Fix `config.ts` defaults       | Small  | High      | —          |
| 3. `ecosystem.config.example.js`  | Small  | High      | —          |
| 4. `docker-compose.yml` (PG only) | Small  | High      | —          |
| 5. Fix hardcoded paths in source  | Medium | High      | #2         |
| 6. Enhance seed script            | Medium | High      | —          |
| 7. Setup script                   | Medium | Very high | #1-6       |
| 8. Onboarding UI                  | Large  | Medium    | #6         |
| 9. VAPID script                   | Small  | Low       | —          |
| 10. Health endpoint               | Small  | Medium    | —          |
| 11. README rewrite                | Medium | Very high | #7         |

Steps 1-4 can be done in parallel. Step 7 depends on 1-6. Step 11 depends on 7.

---

## Open Questions

1. **Should the worker read `.env.local` too?** Currently it reads env exclusively from `ecosystem.config.js`. For simplicity, having one `.env.local` that both Next.js and the worker read would be cleaner. This means either: (a) worker uses dotenv, or (b) PM2 config reads from `.env`.
2. **Agent authentication guidance**: Each CLI has different auth. Should the setup script attempt to check auth status, or just link to docs?
3. **Database name**: Currently `agent_monitor`. Should rename to `agendo` for consistency? (Breaking change for existing installs but cleaner for new ones.)
4. **Test fixtures**: Tests reference `/home/ubuntu`. Leave as-is (they're internal unit tests) or parameterize?
5. **`system-stats` route**: This endpoint talks to a separate monitoring service (`server-monitor-api`). Should it be behind a feature flag for self-hosted users who won't have that service?
