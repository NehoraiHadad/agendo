#!/usr/bin/env bash
# Agendo setup script — from git clone to running instance.
#
# Usage:
#   ./scripts/setup.sh          # production setup (builds everything)
#   ./scripts/setup.sh --dev    # development setup (skips build, use pnpm dev)
#
set -euo pipefail

DEV_MODE=false
if [[ "${1:-}" == "--dev" ]]; then
  DEV_MODE=true
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[x]${NC} $1"; exit 1; }

pg_ready() {
  # Try native pg_isready first
  if command -v pg_isready &>/dev/null; then
    pg_isready -q 2>/dev/null && return 0
  fi
  # Try via Docker
  if [[ "${HAVE_DOCKER:-false}" == "true" ]] && [[ -f docker-compose.yml ]]; then
    docker compose exec -T postgres pg_isready -q 2>/dev/null && return 0
  fi
  # Try via Node.js pg client
  if [[ -d node_modules ]]; then
    node -e "const pg=require('pg');const c=new pg.Client('${DATABASE_URL:-postgresql://agendo:agendo@localhost:5432/agendo}');c.connect().then(()=>{c.end();process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null && return 0
  fi
  return 1
}

check_command() {
  local cmd="$1"
  local min_version="${2:-}"
  local install_hint="$3"

  if ! command -v "$cmd" &>/dev/null; then
    fail "$cmd not found. $install_hint"
  fi

  if [[ -n "$min_version" ]]; then
    local version
    version=$("$cmd" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    local major
    major=$(echo "$version" | cut -d. -f1)
    local required_major
    required_major=$(echo "$min_version" | cut -d. -f1)
    if [[ "$major" -lt "$required_major" ]]; then
      fail "$cmd version $version found, but $min_version+ required."
    fi
  fi

  info "$cmd found: $(command -v "$cmd")"
}

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------

echo ""
echo "=== Agendo Setup ==="
echo ""

check_command "node" "22" "Install Node.js 22+: https://nodejs.org"
check_command "pnpm" "" "Install pnpm: npm install -g pnpm"

HAVE_DOCKER=true
if ! command -v docker &>/dev/null; then
  HAVE_DOCKER=false
  warn "Docker not found. You'll need PostgreSQL running separately."
  warn "Install Docker: https://docs.docker.com/get-docker/"
fi

# Check available RAM
if command -v free &>/dev/null; then
  MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
  if [[ $MEM_MB -lt 3500 ]]; then
    warn "Low memory detected (${MEM_MB}MB). Builds may fail."
    warn "Consider adding swap space before continuing."
  fi
fi

# Check for C compiler (needed by node-pty native addon)
if ! command -v cc &>/dev/null && ! command -v gcc &>/dev/null; then
  warn "No C compiler found. node-pty requires build tools."
  if [[ "$(uname)" == "Darwin" ]]; then
    warn "Run: xcode-select --install"
  else
    warn "Run: sudo apt-get install build-essential python3"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Environment file
# ---------------------------------------------------------------------------

if [[ ! -f .env.local ]]; then
  info "Creating .env.local from .env.example..."
  cp .env.example .env.local

  # Auto-generate JWT_SECRET
  JWT=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/^JWT_SECRET=$/JWT_SECRET=$JWT/" .env.local
  else
    sed -i "s/^JWT_SECRET=$/JWT_SECRET=$JWT/" .env.local
  fi

  # Expand $HOME to actual path in generated .env.local
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|\\\$HOME|$HOME|g" .env.local
  else
    sed -i "s|\\\$HOME|$HOME|g" .env.local
  fi

  info "Generated JWT_SECRET automatically."
else
  info ".env.local already exists, keeping it."
fi

# ---------------------------------------------------------------------------
# 3. Create log directory
# ---------------------------------------------------------------------------

mkdir -p logs
info "Log directory ready: ./logs"

# ---------------------------------------------------------------------------
# 4. Install dependencies
# ---------------------------------------------------------------------------

if [[ ! -d node_modules ]]; then
  info "Installing dependencies..."
  pnpm install
else
  info "node_modules exists, skipping install. Run 'pnpm install' to update."
fi

# ---------------------------------------------------------------------------
# 5. Start PostgreSQL (Docker)
# ---------------------------------------------------------------------------

if [[ "${SKIP_DB:-}" == "1" ]]; then
  warn "SKIP_DB=1 — skipping PostgreSQL check."
elif [[ "$HAVE_DOCKER" == "true" ]] && [[ -f docker-compose.yml ]]; then
  # Check if PostgreSQL is already reachable
  if pg_ready; then
    info "PostgreSQL is already running."
  else
    info "Starting PostgreSQL via Docker Compose..."
    docker compose up -d

    echo -n "  Waiting for PostgreSQL"
    for i in $(seq 1 30); do
      if pg_ready; then
        echo ""
        info "PostgreSQL is ready."
        break
      fi
      echo -n "."
      sleep 1
      if [[ $i -eq 30 ]]; then
        echo ""
        fail "PostgreSQL did not become ready in 30 seconds."
      fi
    done
  fi
else
  if ! pg_ready; then
    warn "PostgreSQL does not appear to be running."
    warn "Start it manually and ensure DATABASE_URL in .env.local is correct."
  else
    info "PostgreSQL is running."
  fi
fi

# ---------------------------------------------------------------------------
# 6. Build (production only)
# ---------------------------------------------------------------------------

if [[ "$DEV_MODE" == "false" ]]; then
  info "Building Next.js app..."
  pnpm build

  info "Building worker..."
  pnpm worker:build

  info "Building MCP server..."
  pnpm build:mcp
else
  info "Dev mode — skipping build step."
fi

# ---------------------------------------------------------------------------
# 7. Database setup
# ---------------------------------------------------------------------------

if [[ "${SKIP_DB:-}" == "1" ]]; then
  warn "SKIP_DB=1 — skipping database setup and seed."
else
  info "Setting up database schema (drizzle-kit push)..."
  pnpm db:setup

  info "Seeding database (agent discovery)..."
  pnpm db:seed
fi

# ---------------------------------------------------------------------------
# 8. Done
# ---------------------------------------------------------------------------

echo ""
echo "=== Setup complete! ==="
echo ""

if [[ "$DEV_MODE" == "true" ]]; then
  echo "Start in development mode:"
  echo ""
  echo "  # Single command (recommended) — runs app, worker, and terminal server"
  echo "  pnpm dev:all"
  echo ""
  echo "  # Or run each service separately:"
  echo ""
  echo "  # Terminal 1 — Next.js app"
  echo "  pnpm dev"
  echo ""
  echo "  # Terminal 2 — Worker (hot-reload)"
  echo "  pnpm worker:dev"
  echo ""
  echo "  # Terminal 3 — Terminal server (optional)"
  echo "  pnpm terminal:dev"
  echo ""
else
  echo "Start the app:"
  echo ""
  echo "  # Simple (foreground)"
  echo "  pnpm start & node dist/worker/index.js &"
  echo ""
  echo "  # Or with PM2 (recommended for always-on):"
  echo "  npm install -g pm2"
  echo "  cp ecosystem.config.example.js ecosystem.config.js"
  echo "  pm2 start ecosystem.config.js"
  echo "  pm2 save"
  echo ""
fi

echo "Verify: ./scripts/smoke-test.sh"
echo "Open:   http://localhost:${PORT:-4100}"
echo ""
