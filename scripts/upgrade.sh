#!/usr/bin/env bash
# upgrade.sh — Safe, automated upgrade for Agendo.
#
# Usage:
#   ./scripts/upgrade.sh                    # upgrade to latest tag
#   ./scripts/upgrade.sh --to v0.3.0       # upgrade to specific version
#   ./scripts/upgrade.sh --force           # skip active session check
#   ./scripts/upgrade.sh --backup-db       # pg_dump before upgrading
#
# This script:
#   1. Pre-flight checks (clean tree, DB reachable, disk space)
#   2. Session safety check (waits for active sessions unless --force)
#   3. Saves rollback point
#   4. Fetches + checks out target tag
#   5. Installs deps, builds, migrates
#   6. Safely restarts all services
#   7. Runs health validation
#   8. Logs the upgrade
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="${AGENDO_LOG_DIR:-/data/agendo/logs}"
UPGRADE_LOG="$LOG_DIR/upgrades.log"
ROLLBACK_FILE="/tmp/agendo-pre-upgrade-sha"
BASE_URL="http://localhost:${AGENDO_PORT:-4100}"
MIN_DISK_GB=2

# Colours
if [ -t 1 ]; then
  RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
  CYAN='\033[0;36m' BOLD='\033[1m' NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' NC=''
fi

info()    { echo -e "${GREEN}[upgrade]${NC} $*"; }
warn()    { echo -e "${YELLOW}[upgrade]${NC} $*"; }
err()     { echo -e "${RED}[upgrade]${NC} $*" >&2; }
bold()    { echo -e "${BOLD}$*${NC}"; }
timestamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

log_upgrade() {
  mkdir -p "$(dirname "$UPGRADE_LOG")"
  echo "[$(timestamp)] $*" >> "$UPGRADE_LOG"
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
TARGET_TAG=""
FORCE=false
BACKUP_DB=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)       TARGET_TAG="$2"; shift 2 ;;
    --force)    FORCE=true; shift ;;
    --backup-db) BACKUP_DB=true; shift ;;
    -h|--help)
      echo ""
      bold "Agendo Upgrade Script"
      echo ""
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --to TAG       Upgrade to specific tag (default: latest)"
      echo "  --force        Skip active session check"
      echo "  --backup-db    Run pg_dump before upgrading"
      echo "  -h, --help     Show this help"
      echo ""
      exit 0
      ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
cd "$PROJECT_ROOT"
START_TIME=$(date +%s)

echo ""
bold "Agendo Upgrade"
echo ""

# 1. Verify project directory
if ! node -e "const p=require('./package.json'); if(p.name!=='agendo') process.exit(1)" 2>/dev/null; then
  err "Not in the agendo project directory. Aborting."
  exit 1
fi
info "Project directory verified"

# 2. Check clean working tree
if [ -n "$(git status --porcelain)" ]; then
  err "Working tree is dirty. Commit or stash changes first."
  git status --short
  exit 1
fi
info "Working tree is clean"

# 3. Check required tools
for cmd in git node pnpm jq curl pm2; do
  if ! command -v "$cmd" &>/dev/null; then
    err "Required command '$cmd' not found."
    exit 1
  fi
done

# 4. Record current state
CURRENT_SHA=$(git rev-parse HEAD)
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
info "Current version: v${CURRENT_VERSION} (${CURRENT_SHA:0:7})"

# 5. Fetch latest tags
info "Fetching tags from origin..."
git fetch --tags origin 2>/dev/null || {
  err "Failed to fetch from origin. Check network/remote."
  exit 1
}

# 6. Determine target version
if [ -z "$TARGET_TAG" ]; then
  TARGET_TAG=$(git tag -l 'v*' --sort=-version:refname | head -1)
  if [ -z "$TARGET_TAG" ]; then
    err "No version tags found on origin."
    exit 1
  fi
fi

# Validate target tag exists
if ! git rev-parse "$TARGET_TAG" &>/dev/null; then
  err "Tag ${TARGET_TAG} does not exist."
  exit 1
fi

TARGET_VERSION="${TARGET_TAG#v}"
TARGET_SHA=$(git rev-parse "$TARGET_TAG")

if [ "$CURRENT_SHA" = "$TARGET_SHA" ]; then
  info "Already at ${TARGET_TAG} (${TARGET_SHA:0:7}). Nothing to do."
  exit 0
fi

info "Target version:  ${TARGET_TAG} (${TARGET_SHA:0:7})"
echo ""

# 7. Check disk space
FREE_GB=$(df -BG "$PROJECT_ROOT" | tail -1 | awk '{print $4}' | tr -d 'G')
if [ "${FREE_GB:-0}" -lt "$MIN_DISK_GB" ]; then
  err "Insufficient disk space: ${FREE_GB}GB free (need ${MIN_DISK_GB}GB)."
  exit 1
fi
info "Disk space: ${FREE_GB}GB free"

# ---------------------------------------------------------------------------
# Session safety check
# ---------------------------------------------------------------------------
if [ "$FORCE" = false ]; then
  info "Checking for active sessions..."
  HEALTH=$(curl -sf --max-time 5 "${BASE_URL}/api/health?detailed=true" 2>/dev/null || echo "")

  if [ -n "$HEALTH" ]; then
    ACTIVE_JOBS=$(echo "$HEALTH" | jq -r '.checks.queue.activeJobs // 0')
    if [ "$ACTIVE_JOBS" -gt 0 ]; then
      warn "${ACTIVE_JOBS} active job(s) detected."
      warn "Waiting for sessions to finish (use --force to skip)..."

      WAIT_START=$(date +%s)
      MAX_WAIT=300

      while true; do
        HEALTH=$(curl -sf --max-time 5 "${BASE_URL}/api/health?detailed=true" 2>/dev/null || echo "")
        ACTIVE_JOBS=$(echo "$HEALTH" | jq -r '.checks.queue.activeJobs // 0' 2>/dev/null || echo "0")

        if [ "$ACTIVE_JOBS" -eq 0 ]; then
          info "All sessions idle."
          break
        fi

        ELAPSED=$(( $(date +%s) - WAIT_START ))
        if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
          warn "Timeout after ${MAX_WAIT}s. Proceeding anyway."
          break
        fi

        echo -ne "\r  Waiting... ${ACTIVE_JOBS} active (${ELAPSED}s / ${MAX_WAIT}s)  "
        sleep 5
      done
      echo ""
    else
      info "No active sessions"
    fi
  else
    warn "Could not reach health endpoint — proceeding"
  fi
fi

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------
echo "$CURRENT_SHA" > "$ROLLBACK_FILE"
info "Saved rollback point: ${ROLLBACK_FILE}"

if [ "$BACKUP_DB" = true ]; then
  DB_BACKUP="/tmp/agendo-pre-upgrade-$(date +%Y%m%d%H%M%S).sql"
  info "Backing up database to ${DB_BACKUP}..."
  pg_dump "${DATABASE_URL:-postgresql://agendo:agendo@localhost:5432/agendo}" > "$DB_BACKUP" 2>/dev/null || {
    warn "pg_dump failed — continuing without DB backup"
  }
fi

# ---------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------
echo ""
bold "Upgrading v${CURRENT_VERSION} → ${TARGET_TAG}..."
echo ""

info "Checking out ${TARGET_TAG}..."
git checkout "$TARGET_TAG" --quiet 2>/dev/null

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>&1 | tail -3

info "Building (app + worker + MCP)..."
pnpm build:all 2>&1 | tail -5

info "Running database migrations..."
pnpm db:migrate 2>&1 | tail -3

# ---------------------------------------------------------------------------
# Safe restart
# ---------------------------------------------------------------------------
echo ""
info "Restarting services..."

if [ -x "$SCRIPT_DIR/safe-restart-worker.sh" ]; then
  "$SCRIPT_DIR/safe-restart-worker.sh" --no-build 2>&1 | tail -3
else
  pm2 restart agendo-worker --update-env 2>/dev/null || true
fi

if [ -x "$SCRIPT_DIR/safe-restart-agendo.sh" ]; then
  "$SCRIPT_DIR/safe-restart-agendo.sh" --force 2>&1 | tail -3
else
  pm2 restart agendo --update-env 2>/dev/null || true
fi

# Restart terminal server if running
pm2 restart agendo-terminal --update-env 2>/dev/null || true

pm2 save --force 2>/dev/null || true

# ---------------------------------------------------------------------------
# Post-upgrade validation
# ---------------------------------------------------------------------------
echo ""
info "Waiting for services to start..."
sleep 5

info "Running health check..."
HEALTH=$(curl -sf --max-time 10 "${BASE_URL}/api/health" 2>/dev/null || echo "")

if [ -n "$HEALTH" ]; then
  STATUS=$(echo "$HEALTH" | jq -r '.status')
  NEW_VERSION=$(echo "$HEALTH" | jq -r '.version')

  if [ "$STATUS" = "ok" ] || [ "$STATUS" = "degraded" ]; then
    info "Health check: ${STATUS} (v${NEW_VERSION})"
  else
    err "Health check failed: ${STATUS}"
    err "Consider rolling back: ./scripts/rollback.sh"
    log_upgrade "UPGRADE v${CURRENT_VERSION} → ${TARGET_TAG} (${CURRENT_SHA:0:7} → ${TARGET_SHA:0:7}) — HEALTH CHECK FAILED"
    exit 1
  fi
else
  warn "Could not reach health endpoint — manual verification needed"
fi

# Run smoke test if available
if [ -x "$SCRIPT_DIR/smoke-test.sh" ]; then
  info "Running smoke test..."
  "$SCRIPT_DIR/smoke-test.sh" "$BASE_URL" 2>&1 | tail -10
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
bold "Upgrade complete!"
echo ""
echo "  Version:  v${CURRENT_VERSION} → ${TARGET_TAG}"
echo "  Duration: ${DURATION}s"
echo "  Rollback: ./scripts/rollback.sh"
echo ""

log_upgrade "UPGRADE v${CURRENT_VERSION} → ${TARGET_TAG} (${CURRENT_SHA:0:7} → ${TARGET_SHA:0:7}) — SUCCESS (${DURATION}s)"
