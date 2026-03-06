# Self-Hosted Deployment Proposal v2

**Status**: Draft for review (second iteration)
**Date**: 2026-03-06

## What Changed Since v1

The first proposal (2026-03-05) identified ~15 issues. Most have already been fixed:

| Issue from v1                                   | Status                            |
| ----------------------------------------------- | --------------------------------- |
| `.env.example` missing                          | DONE                              |
| `ecosystem.config.example.js` missing           | DONE                              |
| `docker-compose.yml` for PostgreSQL             | DONE                              |
| `config.ts` LOG_DIR default `/data/agendo/logs` | FIXED (`./logs`)                  |
| `config.ts` ALLOWED_WORKING_DIRS `/home/ubuntu` | FIXED (`$HOME/projects:/tmp`)     |
| `ecosystem.config.js` hardcoded paths/creds     | FIXED (uses `__dirname` + dotenv) |
| `api/mcp/config/route.ts` hardcoded MCP path    | FIXED (`path.resolve()`)          |
| `api/projects/discover/route.ts` hardcoded home | FIXED (`os.homedir()`)            |
| `session-plan-utils.ts` hardcoded HOME          | FIXED (`os.homedir()`)            |
| Seed script too minimal                         | FIXED (auto-discovers agents)     |
| README rewrite                                  | DONE (7-step quick start)         |

## What Still Needs Fixing

### 1. Terminal port 4101 hardcoded in frontend

**File**: `src/components/terminal/web-terminal.tsx:101`

```typescript
// Current — port 4101 is baked in:
`${window.location.protocol}//${window.location.hostname}:4101`
// Fix — read from env:
`${window.location.protocol}//${window.location.hostname}:${process.env.NEXT_PUBLIC_TERMINAL_WS_PORT || '4101'}`;
```

Or better: expose a `/api/config/client` endpoint that returns runtime config (terminal port, feature flags) so the frontend doesn't need build-time env vars.

### 2. package.json hardcodes `--port 4100`

**File**: `package.json:6,8`

```json
"dev": "next dev --port 4100",
"start": "next start --port 4100",
```

Fix: Use `$PORT` with fallback:

```json
"dev": "next dev --port ${PORT:-4100}",
"start": "next start --port ${PORT:-4100}",
```

Note: shell variable expansion works in npm scripts. Or simply remove `--port` and let Next.js use the `PORT` env var natively (Next.js 16 reads `PORT` automatically).

### 3. Gemini CLI install instruction wrong in README

**File**: `README.md:198`

```bash
# WRONG — copies Claude's install command:
npm install -g @anthropic-ai/claude-code   # placeholder — check Google's docs

# CORRECT:
npm install -g @anthropic-ai/claude-code  # ← this line is for Claude, not Gemini!
```

Should be:

```bash
npm install -g @anthropic-ai/gemini-cli
gemini auth login
```

### 4. No setup script

The README has 7 manual steps. A `scripts/setup.sh` could reduce this to 2:

```bash
git clone ... && cd agendo
./scripts/setup.sh
```

### 5. No `pnpm build:all` convenience script

Three separate build commands (`build`, `worker:build`, `build:mcp`) could be one.

### 6. No health check endpoint

No way to verify the deployment is working except opening the browser.

---

## Database Maintenance Assessment

**Question**: Is the migration system necessary, or can it be replaced with something lighter (like MD files)?

**Answer**: Keep migrations. Here's why:

| Approach                         | Pros                                                                        | Cons                                                                  |
| -------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Drizzle migrations** (current) | Reproducible, version-controlled, safe for new installs, works for team dev | 28 files in `drizzle/` dir                                            |
| **drizzle-kit push**             | Zero migration files, schema.ts is the only truth                           | No audit trail, risky for production, can't share incremental changes |
| **MD files / manual**            | Human-readable                                                              | Not executable, error-prone, defeats the purpose of an ORM            |

For a new user doing `git clone`, migrations are _invisible_ — they just run `pnpm db:migrate` and get a perfect schema. The 28 migration files are an asset, not a burden.

**One improvement**: Add `db:push` as a dev convenience:

```json
"db:push": "drizzle-kit push"
```

This lets developers iterate on schema without generating migrations during active development. They generate the migration once they're happy with the schema. But this is optional — not needed for self-hosted release readiness.

---

## Concrete Implementation Plan

### Priority 0: Must-do (makes clone-to-running actually work)

#### P0-1: Setup script (`scripts/setup.sh`)

This is the single highest-impact change. It should:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Check prerequisites
check_command "node" "22" "Install Node.js 22+: https://nodejs.org"
check_command "pnpm" "" "Install pnpm: npm install -g pnpm"
check_command "docker" "" "Install Docker: https://docs.docker.com/get-docker/"

# 2. Create .env.local from .env.example (if missing)
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  # Auto-generate JWT_SECRET
  JWT=$(openssl rand -hex 32)
  sed -i "s/^JWT_SECRET=$/JWT_SECRET=$JWT/" .env.local
  echo "Created .env.local with generated JWT_SECRET"
fi

# 3. Create log directory
mkdir -p logs

# 4. Install dependencies
pnpm install

# 5. Start PostgreSQL (if docker-compose.yml exists and PG not already running)
if ! pg_isready -q 2>/dev/null; then
  docker compose up -d
  echo "Waiting for PostgreSQL..."
  until pg_isready -q 2>/dev/null; do sleep 1; done
fi

# 6. Build everything
pnpm build && pnpm worker:build && pnpm build:mcp

# 7. Migrate + seed
pnpm db:migrate
pnpm db:seed

# 8. Print success
echo ""
echo "Agendo is ready!"
echo "  Start:  pnpm start & node dist/worker/index.js &"
echo "  Or PM2: cp ecosystem.config.example.js ecosystem.config.js && pm2 start ecosystem.config.js"
echo "  Open:   http://localhost:4100"
```

#### P0-2: Add `build:all` script to package.json

```json
"build:all": "pnpm build && pnpm worker:build && pnpm build:mcp"
```

Reduces cognitive load. README can say `pnpm build:all` instead of three commands.

#### P0-3: Fix terminal port hardcoding

Add `NEXT_PUBLIC_TERMINAL_WS_PORT` to `.env.example` and use it in `web-terminal.tsx`.

#### P0-4: Fix package.json port handling

Remove `--port 4100` from `dev` and `start` scripts — Next.js 16 reads `PORT` env var natively. The `.env.local` already has `PORT=4100`.

#### P0-5: Fix Gemini CLI install instructions in README

Replace the wrong install command.

### Priority 1: Nice-to-have improvements

#### P1-1: Health check endpoint (`GET /api/health`)

Returns:

```json
{
  "status": "ok",
  "db": "connected",
  "worker": "running", // checks worker_heartbeats table
  "agents": ["claude", "codex"], // discovered agents
  "version": "0.1.0"
}
```

Used by the setup script to verify everything works, and by monitoring tools.

#### P1-2: Onboarding detection

When the DB has zero projects and zero tasks, show a welcome screen instead of an empty Kanban board. Guide the user to:

1. Verify agents are discovered
2. Create their first project
3. Create a task and assign it

This is a frontend-only change — no backend work needed.

#### P1-3: `MONITOR_URL` documentation

Add `MONITOR_URL` to `.env.example` with a comment explaining it's for the optional server-monitor-api service. The system-stats route already handles it being unavailable (returns 503), so no code change needed.

#### P1-4: VAPID key generation convenience

```json
"vapid:generate": "npx web-push generate-vapid-keys"
```

Just a script alias — the tool already exists.

---

## Current vs Target: Steps from Clone to Running

### Current (README, manual): 7 steps

```
git clone → pnpm install → docker compose up -d → cp .env.example .env.local + edit JWT_SECRET → pnpm build && pnpm worker:build && pnpm build:mcp → pnpm db:migrate && pnpm db:seed → pnpm start + worker
```

**Pain points**: Must manually generate JWT_SECRET, three separate build commands, must remember both migrate and seed, must start two processes.

### Target with setup script: 3 steps

```bash
git clone https://github.com/NehoraiHadad/agendo.git && cd agendo
pnpm install
./scripts/setup.sh   # generates secrets, starts PG, builds, migrates, seeds, prints instructions
```

Then start with either:

```bash
# Simple (foreground)
pnpm start & node dist/worker/index.js &

# PM2 (always-on)
cp ecosystem.config.example.js ecosystem.config.js
pm2 start ecosystem.config.js
```

### Target with dev mode: 3 steps

```bash
git clone https://github.com/NehoraiHadad/agendo.git && cd agendo
pnpm install
./scripts/setup.sh --dev   # same but skips build, uses dev mode

# Then in two terminals:
pnpm dev
pnpm worker:dev
```

---

## Deployment Model: Final Recommendation

**Native-first. Docker for PostgreSQL only.** This is already implemented correctly.

Full containerization is wrong for Agendo because:

1. Agent CLIs need `~/.claude/`, `~/.codex/`, `~/.gemini/` auth dirs
2. Agents modify files on the host filesystem (that's the whole point)
3. node-pty needs PTY access (adds Docker complexity)
4. PM2-in-Docker is an anti-pattern
5. Auth flows (`claude auth login`) are interactive and host-specific

The docker-compose.yml for PostgreSQL is already in place and works well.

---

## Implementation Order

| #   | Task                               | Effort  | Impact    | Status |
| --- | ---------------------------------- | ------- | --------- | ------ |
| 1   | `build:all` script in package.json | 5 min   | Medium    | TODO   |
| 2   | Fix `--port 4100` in package.json  | 5 min   | Medium    | TODO   |
| 3   | Fix terminal port hardcoding       | 15 min  | Low       | TODO   |
| 4   | Fix Gemini install in README       | 2 min   | Low       | TODO   |
| 5   | Setup script (`scripts/setup.sh`)  | 1-2 hrs | Very High | TODO   |
| 6   | Update README with setup script    | 30 min  | High      | TODO   |
| 7   | Health check endpoint              | 30 min  | Medium    | TODO   |
| 8   | Onboarding detection UI            | 2-3 hrs | Medium    | TODO   |

Items 1-4 are quick fixes that can ship immediately.
Item 5 is the highest-impact single change.
Items 7-8 are polish.

---

## Open Questions (Carried Forward)

1. **Should the worker read `.env.local` directly?** — The `ecosystem.config.example.js` already loads `.env.local` via dotenv. For non-PM2 setups, the worker needs `dotenv` or the user must export vars. Consider adding `dotenv` to the worker entry point as a fallback.

2. **Database name**: `.env.example` uses `agendo`, the live `.env.local` uses `agent_monitor`. New installs will use `agendo` (correct). Existing installs keep `agent_monitor`. No action needed.

3. **Test fixtures**: Tests reference `/home/ubuntu` in fixtures — these are internal unit tests with mocked values. Leave as-is.

4. **System stats**: Already gracefully handles missing monitor (503). Just add `MONITOR_URL` to `.env.example` documentation.
