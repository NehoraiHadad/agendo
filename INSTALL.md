# Installation Guide

Agendo runs natively on your machine (not in Docker) because AI agent CLIs need host-level access to auth configs, project files, and PTY. Docker is used only for PostgreSQL.

---

## Prerequisites

| Requirement | Version | How to install                                                                                                                                                                |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js     | 22+     | https://nodejs.org or `nvm install 22`                                                                                                                                        |
| pnpm        | 10+     | `npm install -g pnpm`                                                                                                                                                         |
| Docker      | any     | https://docs.docker.com/get-docker/ (or bring your own PostgreSQL 15+)                                                                                                        |
| Build tools | any     | Linux: `sudo apt-get install build-essential python3`; macOS: `xcode-select --install`; Windows: [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) |
| AI CLI      | any     | At least one of: `claude`, `codex`, `gemini` (see [Agent CLI Setup](#agent-cli-setup))                                                                                        |

---

## Linux / macOS -- Automatic Setup

```bash
git clone https://github.com/NehoraiHadad/agendo.git
cd agendo
./scripts/setup.sh
```

The setup script performs these steps in order:

1. **Checks prerequisites** -- verifies Node.js 22+, pnpm, Docker, build tools, and available RAM
2. **Creates `.env.local`** from `.env.example` -- auto-generates a `JWT_SECRET` and expands `$HOME` paths
3. **Creates `./logs` directory** for session log files
4. **Installs dependencies** -- `pnpm install` (includes native `node-pty` compilation)
5. **Starts PostgreSQL** via Docker Compose (or detects an existing instance)
6. **Builds everything** -- Next.js app, worker (esbuild), and MCP server bundle
7. **Sets up the database** -- pushes schema via Drizzle, then seeds agents and capabilities

For **development mode** (skips the build step):

```bash
./scripts/setup.sh --dev
```

After setup completes, start the services:

```bash
# Option A: PM2 (recommended for always-on servers)
npm install -g pm2
cp ecosystem.config.example.js ecosystem.config.js
pm2 start ecosystem.config.js && pm2 save

# Option B: Dev mode (hot-reload, single terminal)
pnpm dev:all

# Option C: Dev mode (separate terminals)
pnpm dev            # Terminal 1 -- Next.js app (port 4100)
pnpm worker:dev     # Terminal 2 -- Worker with hot-reload
pnpm terminal:dev   # Terminal 3 -- Terminal server (port 4101, optional)
```

---

## Windows -- Automatic Setup

Agendo supports Windows natively via PowerShell or through WSL 2.

### PowerShell (native)

```powershell
git clone https://github.com/NehoraiHadad/agendo.git
cd agendo
.\scripts\install.ps1
```

If you get an execution policy error:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
.\scripts\install.ps1
```

The PowerShell installer mirrors the Linux setup script: checks prerequisites (including VS Build Tools), creates `.env.local`, installs deps, starts PostgreSQL via Docker, builds, and seeds the database.

For development mode:

```powershell
.\scripts\install.ps1 -Dev
```

### WSL 2 (alternative)

1. Install WSL 2: `wsl --install` (from an elevated PowerShell)
2. Open your WSL terminal (Ubuntu recommended)
3. Install Node.js 22+ and pnpm inside WSL
4. Follow the Linux setup instructions above
5. Docker Desktop must have WSL 2 integration enabled for PostgreSQL

---

## Manual Installation (all platforms)

If you prefer not to use the setup scripts, follow these steps:

### 1. Clone and install dependencies

```bash
git clone https://github.com/NehoraiHadad/agendo.git
cd agendo
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` and set the required values:

```bash
# Generate a JWT secret (required, min 16 characters)
openssl rand -hex 32
# Paste the output as JWT_SECRET= in .env.local
```

The `DATABASE_URL` default (`postgresql://agendo:agendo@localhost:5432/agendo`) works with the included Docker Compose file.

### 3. Create log directory

```bash
mkdir -p logs
```

### 4. Start PostgreSQL

Using the included Docker Compose file:

```bash
docker compose up -d
```

Or use your own PostgreSQL 15+ instance and update `DATABASE_URL` in `.env.local` accordingly.

### 5. Build

```bash
pnpm build          # Next.js production build
pnpm worker:build   # Worker bundle (esbuild)
pnpm build:mcp      # MCP server bundle
```

Or all at once (includes type-checking):

```bash
pnpm build:all
```

### 6. Set up the database

```bash
pnpm db:setup       # Push schema via drizzle-kit
pnpm db:seed        # Seed agents, capabilities, and config
```

### 7. Set up PM2 (optional but recommended)

```bash
npm install -g pm2
cp ecosystem.config.example.js ecosystem.config.js
pm2 start ecosystem.config.js
pm2 save
```

### 8. Open the app

Navigate to **http://localhost:4100**.

---

## Environment Configuration

All environment variables are defined in `.env.example`. The setup script creates `.env.local` automatically. Key variables:

### Required

| Variable       | Description                          |
| -------------- | ------------------------------------ |
| `DATABASE_URL` | PostgreSQL connection string         |
| `JWT_SECRET`   | Authentication secret (min 16 chars) |

Generate `JWT_SECRET`:

```bash
openssl rand -hex 32
```

### Optional (with defaults)

| Variable                       | Default                | Description                            |
| ------------------------------ | ---------------------- | -------------------------------------- |
| `PORT`                         | `4100`                 | Next.js app port                       |
| `TERMINAL_WS_PORT`             | `4101`                 | Terminal WebSocket server port         |
| `NEXT_PUBLIC_TERMINAL_WS_PORT` | `4101`                 | Terminal port exposed to the browser   |
| `LOG_DIR`                      | `./logs`               | Session log directory                  |
| `ALLOWED_WORKING_DIRS`         | `$HOME/projects:/tmp`  | Colon-separated dirs agents can access |
| `MCP_SERVER_PATH`              | `./dist/mcp-server.js` | Path to bundled MCP server             |
| `WORKER_ID`                    | `worker-1`             | Worker identity                        |
| `WORKER_MAX_CONCURRENT_JOBS`   | `3`                    | Max parallel agent sessions            |

### Push Notifications (optional)

Generate VAPID keys for PWA push notifications:

```bash
npx web-push generate-vapid-keys
```

Add the output to `.env.local`:

```env
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public key>
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:you@example.com
```

Push notifications are disabled if VAPID keys are not set.

### Worker environment

The Next.js app reads `.env.local` directly. The worker reads environment variables from `ecosystem.config.js`, which loads `.env.local` via dotenv. If you change `.env.local`, restart the worker:

```bash
pm2 restart agendo-worker --update-env
```

---

## Agent CLI Setup

Agendo auto-discovers agent CLIs from your PATH during `pnpm db:seed`. Install and authenticate the agents you want to use, then re-run the seed to register them.

### Claude Code (Anthropic)

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

This opens a browser for OAuth authentication. No API key needed.

### OpenAI Codex

```bash
npm install -g @openai/codex
codex login
```

Authenticates via OpenAI API key (prompted interactively).

### Google Gemini

```bash
npm install -g @google/gemini-cli
gemini auth login
```

This opens a browser for Google OAuth authentication.

### After installing new CLIs

Re-run the seed to discover and register newly installed agents:

```bash
pnpm db:seed
```

---

## Verifying Installation

Run the smoke test to verify everything is working:

```bash
./scripts/smoke-test.sh
```

The smoke test checks:

- **Health endpoint** -- confirms the app is reachable and reports status
- **Database** -- connection and latency
- **Worker** -- confirms the background worker is running
- **Agents** -- counts discovered agents
- **MCP server** -- confirms the bundle exists at `dist/mcp-server.js`
- **Disk space** -- checks free disk
- **API routes** -- hits `/api/projects`, `/api/agents`, `/api/tasks`, `/api/dashboard`, `/api/workers/status`
- **Agent binaries** -- checks if `claude`, `codex`, `gemini` are on PATH
- **Write test** -- creates and deletes a test task

You can also pass a custom URL:

```bash
./scripts/smoke-test.sh http://your-server:4100
```

Expected output for a healthy install:

```
=== Agendo Smoke Test ===
  PASS Health status: ok
  PASS Database: connected
  PASS Worker: running
  PASS Agents discovered: 3
  PASS MCP server bundle: exists
  ...
Smoke test PASSED
```

---

## Troubleshooting

### Port 4100 already in use

Another process is using port 4100. Find and stop it:

```bash
lsof -i :4100       # macOS/Linux
# or change PORT in .env.local
```

### node-pty build failure (missing build tools)

`node-pty` is a native addon that requires a C compiler:

- **Linux**: `sudo apt-get install build-essential python3`
- **macOS**: `xcode-select --install`
- **Windows**: Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload

After installing build tools, remove `node_modules` and reinstall:

```bash
rm -rf node_modules
pnpm install
```

### Low memory / OOM during build

The Next.js build and TypeScript type-checking can use significant memory. On machines with less than 4GB RAM:

- Add swap space: `sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
- Build components separately instead of `pnpm build:all`:

```bash
pnpm build          # Next.js
pnpm worker:build   # Worker (esbuild, low memory)
pnpm build:mcp      # MCP server (low memory)
```

### PostgreSQL not starting

Check Docker is running:

```bash
docker info
docker compose logs postgres
```

If using your own PostgreSQL, verify the connection:

```bash
psql postgresql://agendo:agendo@localhost:5432/agendo -c "SELECT 1"
```

### pg_isready: command not found

The setup script can check PostgreSQL readiness without `pg_isready` -- it falls back to Docker exec and then a Node.js pg client connection. If the setup script reports PostgreSQL issues, check `docker compose logs postgres`.

### Agents not appearing after seed

1. Confirm the CLI is installed and on your PATH:

```bash
which claude codex gemini
```

2. Re-run the seed:

```bash
pnpm db:seed
```

3. Check the seed output for discovery messages. The seed scans PATH for known binary names (`claude`, `codex`, `gemini`) and registers any it finds.

### Worker not connecting

If the smoke test shows "Worker: not running":

```bash
# Check PM2 status
pm2 status

# Check worker logs
pm2 logs agendo-worker --lines 50

# Restart the worker
pm2 restart agendo-worker
```

Common causes: `DATABASE_URL` mismatch between `.env.local` and `ecosystem.config.js`, or the worker bundle hasn't been built (`pnpm worker:build`).

---

## Remote Access (Tailscale)

For accessing Agendo from phones, tablets, or other machines on your network:

1. Install [Tailscale](https://tailscale.com) on your server and client devices
2. Agendo is available at `http://<machine-name>:4100` over your Tailscale network
3. No reverse proxy, SSL, or port forwarding needed

For HTTPS (needed for PWA push notifications on mobile), use [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) or `tailscale cert`.

---

## Upgrading

```bash
git pull
pnpm install           # install any new/updated dependencies
pnpm build:all         # rebuild app + worker + MCP server
pnpm db:migrate        # apply any new database migrations
pm2 restart all        # restart services
```

If there are new environment variables, check `.env.example` and add them to your `.env.local`.

---

## Services Reference

| Service  | PM2 Name          | Default Port | Description                                   |
| -------- | ----------------- | ------------ | --------------------------------------------- |
| App      | `agendo`          | 4100         | Web UI, API routes, SSE endpoints, MCP host   |
| Worker   | `agendo-worker`   | --           | Job queue processor, agent subprocess manager |
| Terminal | `agendo-terminal` | 4101         | xterm.js + node-pty over WebSocket (optional) |

PM2 configuration: `ecosystem.config.js` (copy from `ecosystem.config.example.js`).
