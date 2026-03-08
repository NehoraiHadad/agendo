# Setup Script & Onboarding Analysis

> Analysis date: 2026-03-06
> Status: Recommendations only — no implementation changes

---

## Table of Contents

1. [Current State Overview](#1-current-state-overview)
2. [Pain Points with Line References](#2-pain-points-with-line-references)
3. [Platform Compatibility Matrix](#3-platform-compatibility-matrix)
4. [Recommendation: Bash vs Node.js Setup Script](#4-recommendation-bash-vs-nodejs-setup-script)
5. [Recommended Changes](#5-recommended-changes)
6. [Effort Estimates](#6-effort-estimates)

---

## 1. Current State Overview

The setup flow is: **clone → run setup.sh → start services**.

### Current prerequisite chain

```
User manually installs:
  Node.js 22+ → pnpm 10+ → Docker (optional) → at least one AI CLI

Then:
  git clone → cd agendo → ./scripts/setup.sh [--dev]
```

### What setup.sh does (7 steps)

| Step | Lines   | Action                                                            |
| ---- | ------- | ----------------------------------------------------------------- |
| 1    | 54-68   | Check prerequisites (node, pnpm, docker)                          |
| 2    | 70-89   | Create `.env.local` from `.env.example`, auto-generate JWT_SECRET |
| 3    | 91-96   | Create `./logs` directory                                         |
| 4    | 98-107  | Run `pnpm install` (if no node_modules)                           |
| 5    | 109-143 | Start PostgreSQL via Docker Compose, wait for readiness           |
| 6    | 145-160 | Build Next.js + worker + MCP (production only)                    |
| 7    | 162-170 | Run `drizzle-kit push` + seed agents                              |

### What works well

- Auto-generates JWT_SECRET with `openssl rand -hex 32` (line 79)
- macOS-aware `sed -i` (lines 80-84) — handles the BSD `sed -i ''` vs GNU `sed -i`
- Docker is optional with graceful fallback (lines 63-68, 136-143)
- `--dev` flag skips build (line 149)
- Agent auto-discovery via `runDiscovery()` in seed.ts is elegant — scans PATH for known binaries
- `.env.example` is well-documented with sensible defaults

---

## 2. Pain Points with Line References

### P1: `grep -oP` uses GNU PCRE — fails on macOS (CRITICAL)

**File:** `scripts/setup.sh:39`

```bash
version=$("$cmd" --version 2>&1 | grep -oP '\d+\.\d+' | head -1)
```

macOS ships BSD grep, which does **not** support `-P` (Perl-compatible regex). This causes the version check for Node.js (line 60) to silently fail with an error on every macOS machine.

**Impact:** The `check_command "node" "22"` call at line 60 will fail or produce an empty `$version`, causing the comparison at line 44 (`[[ "$major" -lt "$required_major" ]]`) to error out with `integer expression expected`.

**Fix options:**

- (a) Use `grep -oE '[0-9]+\.[0-9]+'` — POSIX Extended regex works everywhere
- (b) Use `sed` or `awk` instead: `"$cmd" --version 2>&1 | sed -n 's/.*\([0-9]\+\.[0-9]\+\).*/\1/p' | head -1`
- (c) For Node specifically: `node -e "process.stdout.write(process.versions.node)"` is most reliable

**Recommended fix (simplest):**

```bash
version=$("$cmd" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
```

### P2: No Windows support — bash-only

The entire setup script is bash. Windows users without WSL2 cannot run it at all.

**Impact:** Windows is a major developer platform. Many Agendo users will be on macOS or Windows.

**Options:**

- (a) Document WSL2 as the recommended path (low effort, pragmatic)
- (b) Rewrite setup in Node.js (cross-platform, medium effort — see section 4)
- (c) Provide both bash and PowerShell scripts (high maintenance burden)

### P3: `pg_isready` may not be installed

**File:** `scripts/setup.sh:115, 137`

`pg_isready` is a PostgreSQL client tool. It's not guaranteed to be installed on the host, especially if the user only runs PG via Docker. The script uses it to check if PostgreSQL is running.

**Impact:** On a fresh machine with Docker-only PostgreSQL (no `libpq-dev` or `postgresql-client`), `pg_isready` is not in PATH. The Docker health check (docker-compose.yml:24-28) runs `pg_isready` _inside_ the container, but the host script calls it on the host.

**Fix:** Use `docker compose exec postgres pg_isready` when Docker is available, or fall back to a `pg` Node.js connection test:

```bash
# Option A: Docker-aware
if [[ "$HAVE_DOCKER" == "true" ]]; then
  docker compose exec -T postgres pg_isready -U agendo
else
  node -e "const pg = require('pg'); const c = new pg.Client(process.env.DATABASE_URL); c.connect().then(() => { c.end(); process.exit(0) }).catch(() => process.exit(1))"
fi
```

### P4: `pnpm install` before setup.sh, but setup.sh also runs `pnpm install`

**File:** `README.md:53-54`, `scripts/setup.sh:102-107`

The README tells users to run `pnpm install` before `./scripts/setup.sh`, but setup.sh also runs `pnpm install` if `node_modules` doesn't exist. This is redundant. If we keep setup.sh doing the install, the README should skip it:

```bash
# Current README (redundant):
pnpm install            # ← unnecessary
./scripts/setup.sh

# Should be:
./scripts/setup.sh      # handles pnpm install internally
```

### P5: No interactive fallback for DATABASE_URL

**File:** `scripts/setup.sh:74-89`, `.env.example:17`

When Docker is not available, the script warns but doesn't ask for a DATABASE_URL. The default `postgresql://agendo:agendo@localhost:5432/agendo` is hardcoded in `.env.example:17`. Users with an existing PG instance must manually edit `.env.local` after the script runs.

**Improvement:** Prompt the user when Docker is absent:

```bash
if [[ "$HAVE_DOCKER" == "false" ]]; then
  read -p "Enter DATABASE_URL [postgresql://agendo:agendo@localhost:5432/agendo]: " DB_URL
  DB_URL="${DB_URL:-postgresql://agendo:agendo@localhost:5432/agendo}"
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env.local
fi
```

### P6: `openssl` dependency for JWT generation

**File:** `scripts/setup.sh:79`

`openssl` is almost universally available on Linux and macOS but **not** on Windows (even in Git Bash). A Node.js equivalent is trivially available:

```bash
JWT=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

### P7: ALLOWED_WORKING_DIRS uses `$HOME` expansion in .env.example

**File:** `.env.example:51`

```
ALLOWED_WORKING_DIRS=$HOME/projects:/tmp
```

`$HOME` expands at shell read time when sourced by `dotenv`, but `.env.local` is read by Node.js `dotenv` which does NOT expand `$HOME`. The actual runtime value will be the literal string `$HOME/projects:/tmp`.

**Current workaround:** `ecosystem.config.example.js:82` uses `process.env.HOME` to expand it. And `config.ts:14` uses `process.env.HOME`. But `.env.local` itself contains the unexpanded `$HOME`.

**Impact:** If a user reads `.env.local` and trusts it at face value, it's misleading. The actual expansion happens in config.ts (for Next.js) and ecosystem.config.js (for worker), so it works — but only because both have fallback logic.

**Fix:** The setup script should expand `$HOME` when creating `.env.local`:

```bash
sed -i "s|\$HOME|$HOME|g" .env.local
```

### P8: node-pty requires native compilation

**File:** `package.json:52` — `"node-pty": "^1.1.0"`

`node-pty` requires a C++ compiler and Python for node-gyp. This is a common friction point:

- macOS: Needs Xcode Command Line Tools (`xcode-select --install`)
- Ubuntu/Debian: Needs `build-essential`, `python3`
- Windows: Needs Visual Studio Build Tools

The setup script doesn't check for these. If `pnpm install` fails on node-pty, the error is cryptic.

**Fix:** Add a pre-check or helpful error message. Or make node-pty optional (the terminal server is already optional).

### P9: Build step can OOM on low-memory machines

**File:** `scripts/setup.sh:151` — `pnpm build`

`next build` + `tsc` can consume >4GB RAM. The setup script doesn't warn about this. `package.json:13` already sets `NODE_OPTIONS=--max-old-space-size=4096` for typecheck, and the worker build uses esbuild (which is fast/lean), but `next build` itself can spike.

**Impact:** VPS instances with 2GB RAM will OOM during setup.

**Fix:** Document minimum 4GB RAM requirement, or add a memory check:

```bash
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
if [[ $MEM_MB -lt 3500 ]]; then
  warn "Less than 4GB RAM detected ($MEM_MB MB). Build may fail."
  warn "Consider adding swap: sudo fallocate -l 4G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
fi
```

### P10: No prerequisite auto-installation

Users must manually install Node 22, pnpm, and Docker before running setup. There's no `curl | sh` bootstrap or detection+installation flow.

---

## 3. Platform Compatibility Matrix

### Current state

| Feature                          |          Linux (Ubuntu)          |         macOS         |            Windows (native)            | Windows (WSL2) |
| -------------------------------- | :------------------------------: | :-------------------: | :------------------------------------: | :------------: |
| `./scripts/setup.sh`             |               Yes                | **BROKEN** (grep -oP) |                   No                   |      Yes       |
| `grep -oP` version check         |          Yes (GNU grep)          |   **No** (BSD grep)   |                  N/A                   |      Yes       |
| `openssl rand`                   |               Yes                |          Yes          |          **No** (not in PATH)          |      Yes       |
| `sed -i`                         |               Yes                |     Yes (handled)     |                  N/A                   |      Yes       |
| `pg_isready`                     | If `postgresql-client` installed | If `libpq` installed  |                  N/A                   |  If installed  |
| Docker Compose                   |               Yes                |          Yes          |          Yes (Docker Desktop)          |      Yes       |
| `pnpm install`                   |               Yes                |          Yes          |                  Yes                   |      Yes       |
| node-pty compile                 |     Yes (if build-essential)     |  Yes (if Xcode CLT)   |        Yes (if VS Build Tools)         |      Yes       |
| AI CLIs in PATH                  |               Yes                |          Yes          |                Partial                 |      Yes       |
| Agent discovery (scanner.ts)     |               Yes                |          Yes          |  **Partial** (path.delimiter is `;`)   |      Yes       |
| `ALLOWED_WORKING_DIRS` splitting |       Yes (`:` separator)        |          Yes          | **BROKEN** (Windows paths contain `:`) |      Yes       |

### After proposed fixes

| Feature            | Linux | macOS | Windows (WSL2) | Windows (native via Node.js setup) |
| ------------------ | :---: | :---: | :------------: | :--------------------------------: |
| Setup script       |  Yes  |  Yes  |      Yes       |                Yes                 |
| Version checks     |  Yes  |  Yes  |      Yes       |                Yes                 |
| JWT generation     |  Yes  |  Yes  |      Yes       |                Yes                 |
| PG readiness check |  Yes  |  Yes  |      Yes       |                Yes                 |
| Build              |  Yes  |  Yes  |      Yes       |                Yes                 |

### Key insight: Windows native is a non-goal

Agendo spawns AI CLI subprocesses, manages PTY sessions, uses PG NOTIFY, and assumes Unix-like filesystem paths throughout. Full Windows native support would require massive changes beyond the setup script. **WSL2 is the correct path for Windows users** — it should be documented clearly, not worked around.

---

## 4. Recommendation: Bash vs Node.js Setup Script

### Option A: Fix the bash script (RECOMMENDED for now)

| Pro                       | Con                                            |
| ------------------------- | ---------------------------------------------- |
| Minimal change            | Still bash-only (no native Windows)            |
| Users expect `./setup.sh` | Can't use npm readline for interactive prompts |
| No new dependencies       | Limited error handling compared to Node.js     |
| Fast to implement         |                                                |

**Effort:** 1-2 hours to fix all bash issues (grep -oP, pg_isready, openssl, $HOME expansion).

### Option B: Node.js setup.mjs

| Pro                                                    | Con                                                      |
| ------------------------------------------------------ | -------------------------------------------------------- |
| Cross-platform (Linux, macOS, Windows via WSL2)        | Needs Node.js installed first (chicken-and-egg)          |
| Can use `readline` for interactive prompts             | More code than bash for simple tasks                     |
| Can import `config.ts` schema for validation           | Overkill for what's mostly file copying + shell commands |
| Can use `child_process` for all subprocess calls       | Users expect setup scripts to be bash                    |
| Better error messages via try/catch                    |                                                          |
| Can validate .env against Zod schema before proceeding |                                                          |

**Effort:** 4-6 hours to rewrite.

### Option C: Hybrid — bash bootstrap + Node.js setup

```bash
#!/usr/bin/env bash
# Bootstrap: check Node exists, then hand off to Node.js
if ! command -v node &>/dev/null; then
  echo "Node.js 22+ is required. Install from https://nodejs.org"
  exit 1
fi
exec node scripts/setup.mjs "$@"
```

This gets the best of both worlds: a 5-line bash shim that verifies Node.js exists, then runs the real setup in Node.js.

| Pro                                      | Con                                      |
| ---------------------------------------- | ---------------------------------------- |
| Best of both worlds                      | Two files to maintain (shim + setup.mjs) |
| Interactive prompts via Node.js readline | Slight indirection                       |
| Cross-platform Node.js logic             |                                          |
| Can validate against Zod schema          |                                          |

**Effort:** 5-7 hours.

### Verdict

**Short-term (v0.1):** Fix the bash script (Option A). The `grep -oP` fix is a one-line change. Add the other small improvements. This unblocks macOS users immediately.

**Medium-term (v0.2+):** Move to Option C (hybrid) when we want interactive prompts, env validation, and a polished onboarding UX. The Node.js setup can import config.ts's Zod schema to validate `.env.local` before the app starts, catching misconfigurations early.

---

## 5. Recommended Changes

### Change 1: Fix `grep -oP` for macOS (CRITICAL)

**File:** `scripts/setup.sh:39`

```bash
# Before (GNU grep only):
version=$("$cmd" --version 2>&1 | grep -oP '\d+\.\d+' | head -1)

# After (POSIX-compatible):
version=$("$cmd" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
```

**Effort:** 5 minutes.

### Change 2: Use Node.js for JWT generation (portability)

**File:** `scripts/setup.sh:79`

```bash
# Before:
JWT=$(openssl rand -hex 32)

# After:
JWT=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
```

Since Node.js is already a prerequisite, this eliminates the openssl dependency.

**Effort:** 5 minutes.

### Change 3: Fix pg_isready dependency

**File:** `scripts/setup.sh:115, 137`

Replace bare `pg_isready` with a function that tries multiple methods:

```bash
pg_ready() {
  # Method 1: pg_isready on host
  if command -v pg_isready &>/dev/null; then
    pg_isready -q 2>/dev/null && return 0
  fi
  # Method 2: Docker health check
  if [[ "$HAVE_DOCKER" == "true" ]]; then
    docker compose exec -T postgres pg_isready -U agendo -q 2>/dev/null && return 0
  fi
  # Method 3: Node.js connection test (works after pnpm install)
  if [[ -d node_modules ]]; then
    node -e "
      const pg = require('pg');
      const c = new pg.Client('${DATABASE_URL:-postgresql://agendo:agendo@localhost:5432/agendo}');
      c.connect().then(() => { c.end(); process.exit(0) }).catch(() => process.exit(1))
    " 2>/dev/null && return 0
  fi
  return 1
}
```

**Effort:** 30 minutes.

### Change 4: Expand `$HOME` in generated .env.local

**File:** `scripts/setup.sh` — add after line 84:

```bash
# Expand $HOME in .env.local so dotenv reads correct paths
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s|\\\$HOME|$HOME|g" .env.local
else
  sed -i "s|\\\$HOME|$HOME|g" .env.local
fi
```

**Effort:** 10 minutes.

### Change 5: Remove redundant `pnpm install` from README

**File:** `README.md:53`

Change from:

```bash
git clone ...
cd agendo
pnpm install         # remove this line
./scripts/setup.sh
```

To:

```bash
git clone ...
cd agendo
./scripts/setup.sh
```

The setup script handles `pnpm install` at step 4 (lines 102-107).

**Effort:** 2 minutes.

### Change 6: Add memory/build-tools warnings

**File:** `scripts/setup.sh` — add in prerequisites section after line 68:

```bash
# Check available memory (Linux only)
if command -v free &>/dev/null; then
  MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
  if [[ $MEM_MB -lt 3500 ]]; then
    warn "Low memory detected (${MEM_MB}MB). Builds may fail."
    warn "Consider adding swap space before continuing."
  fi
fi

# Check for C++ compiler (needed by node-pty)
if ! command -v cc &>/dev/null && ! command -v gcc &>/dev/null; then
  warn "No C compiler found. node-pty requires build tools."
  if [[ "$(uname)" == "Darwin" ]]; then
    warn "Run: xcode-select --install"
  else
    warn "Run: sudo apt-get install build-essential python3"
  fi
fi
```

**Effort:** 15 minutes.

### Change 7: Add WSL2 documentation for Windows users

**File:** `README.md` — add a section:

```markdown
### Windows

Agendo requires a Unix-like environment. Use WSL2:

1. Install WSL2: `wsl --install -d Ubuntu-24.04`
2. Inside WSL2, install Node.js 22+, pnpm, and Docker
3. Clone and run setup as normal
```

**Effort:** 10 minutes.

### Change 8: Interactive DATABASE_URL prompt when Docker is absent

**File:** `scripts/setup.sh` — extend the no-Docker warning block (lines 136-143):

```bash
if [[ "$HAVE_DOCKER" == "false" ]] && [[ ! -f .env.local.user-edited ]]; then
  if ! pg_ready; then
    warn "PostgreSQL not reachable and Docker not available."
    echo ""
    read -p "  Enter DATABASE_URL [postgresql://agendo:agendo@localhost:5432/agendo]: " DB_URL
    DB_URL="${DB_URL:-postgresql://agendo:agendo@localhost:5432/agendo}"
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env.local
    else
      sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env.local
    fi
    info "DATABASE_URL set to: $DB_URL"
  fi
fi
```

**Effort:** 20 minutes.

---

## 6. Effort Estimates Summary

| #   | Change                                    | Priority | Effort         | Platform Impact                  |
| --- | ----------------------------------------- | -------- | -------------- | -------------------------------- |
| 1   | Fix `grep -oP` → `grep -oE`               | **P0**   | 5 min          | Fixes macOS completely           |
| 2   | Node.js JWT generation                    | P1       | 5 min          | Removes openssl dep              |
| 3   | Fix pg_isready dependency                 | P1       | 30 min         | Fixes fresh Docker-only installs |
| 4   | Expand $HOME in .env.local                | P2       | 10 min         | Prevents confusion               |
| 5   | Remove redundant pnpm install from README | P2       | 2 min          | Simplifies onboarding            |
| 6   | Memory + build-tools warnings             | P2       | 15 min         | Prevents cryptic failures        |
| 7   | WSL2 documentation                        | P2       | 10 min         | Unblocks Windows users           |
| 8   | Interactive DATABASE_URL prompt           | P3       | 20 min         | Better no-Docker UX              |
| —   | **Total (all bash fixes)**                | —        | **~1.5 hours** | —                                |
| —   | Node.js rewrite (future)                  | P3       | 5-7 hours      | Full cross-platform              |

### Recommended implementation order

1. **Changes 1-2** — one PR, 10 minutes, fixes the macOS blocker
2. **Changes 3-6** — one PR, ~1 hour, hardens the setup for edge cases
3. **Changes 7-8** — one PR, 30 minutes, improves docs + UX
4. **Node.js rewrite** — future milestone, when interactive onboarding is needed

---

## Appendix: scanner.ts cross-platform notes

The agent discovery code (`src/lib/discovery/scanner.ts`) is already reasonably cross-platform:

- Uses `path.delimiter` (line 19) — correctly handles `;` on Windows
- Uses `fs.access` with `X_OK` (line 39) — works on all platforms
- Uses `path.join` (line 37) — handles path separators correctly

However, `ALLOWED_WORKING_DIRS` in `config.ts:49` splits on `:` which would break on Windows paths like `C:\Users\...`. This is fine for now since Windows native is not supported, but would need attention in a Node.js rewrite.
