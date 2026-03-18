#!/usr/bin/env bash
# rollback.sh — Revert Agendo to a previous version after a failed upgrade.
#
# Usage:
#   ./scripts/rollback.sh              # rollback to pre-upgrade SHA
#   ./scripts/rollback.sh abc1234      # rollback to specific SHA
#   ./scripts/rollback.sh v0.1.0       # rollback to specific tag
#
# WARNING: Database migrations are forward-only. If a migration was applied
# during the upgrade, manual DB intervention may be needed.
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

# Colours
if [ -t 1 ]; then
  RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
  BOLD='\033[1m' NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BOLD='' NC=''
fi

info()    { echo -e "${GREEN}[rollback]${NC} $*"; }
warn()    { echo -e "${YELLOW}[rollback]${NC} $*"; }
err()     { echo -e "${RED}[rollback]${NC} $*" >&2; }
bold()    { echo -e "${BOLD}$*${NC}"; }
timestamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

log_upgrade() {
  mkdir -p "$(dirname "$UPGRADE_LOG")"
  echo "[$(timestamp)] $*" >> "$UPGRADE_LOG"
}

# ---------------------------------------------------------------------------
# Determine target
# ---------------------------------------------------------------------------
cd "$PROJECT_ROOT"
START_TIME=$(date +%s)

TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  if [ -f "$ROLLBACK_FILE" ]; then
    TARGET=$(cat "$ROLLBACK_FILE")
    info "Using rollback point from ${ROLLBACK_FILE}: ${TARGET:0:7}"
  else
    err "No rollback point found. Provide a SHA or tag as argument."
    echo ""
    echo "Usage: $0 [SHA|TAG]"
    echo ""
    echo "Recent tags:"
    git tag -l 'v*' --sort=-version:refname | head -5 | sed 's/^/  /'
    exit 1
  fi
fi

# Resolve tag to SHA if needed
if git rev-parse "$TARGET" &>/dev/null; then
  TARGET_SHA=$(git rev-parse "$TARGET")
else
  err "Cannot resolve '${TARGET}'. Not a valid SHA or tag."
  exit 1
fi

CURRENT_SHA=$(git rev-parse HEAD)
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")

if [ "$CURRENT_SHA" = "$TARGET_SHA" ]; then
  info "Already at target (${TARGET_SHA:0:7}). Nothing to do."
  exit 0
fi

echo ""
bold "Agendo Rollback"
echo ""
info "Current: v${CURRENT_VERSION} (${CURRENT_SHA:0:7})"
info "Target:  ${TARGET} (${TARGET_SHA:0:7})"
echo ""

warn "Database migrations are forward-only."
warn "If a migration was applied during the upgrade, manual DB intervention may be needed."
echo ""

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
info "Checking out ${TARGET}..."
git checkout "$TARGET_SHA" --quiet 2>/dev/null

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>&1 | tail -3

info "Building (app + worker + MCP)..."
pnpm build:all 2>&1 | tail -5

# ---------------------------------------------------------------------------
# Restart services
# ---------------------------------------------------------------------------
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

pm2 restart agendo-terminal --update-env 2>/dev/null || true
pm2 save --force 2>/dev/null || true

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
info "Waiting for services to start..."
sleep 5

HEALTH=$(curl -sf --max-time 10 "${BASE_URL}/api/health" 2>/dev/null || echo "")

if [ -n "$HEALTH" ]; then
  STATUS=$(echo "$HEALTH" | jq -r '.status')
  ROLLED_VERSION=$(echo "$HEALTH" | jq -r '.version')
  info "Health check: ${STATUS} (v${ROLLED_VERSION})"
else
  warn "Could not reach health endpoint — manual verification needed"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
bold "Rollback complete!"
echo ""
echo "  Reverted: v${CURRENT_VERSION} → ${TARGET}"
echo "  Duration: ${DURATION}s"
echo ""

log_upgrade "ROLLBACK v${CURRENT_VERSION} → ${TARGET} (${CURRENT_SHA:0:7} → ${TARGET_SHA:0:7}) — SUCCESS (${DURATION}s)"

# Clean up rollback file
rm -f "$ROLLBACK_FILE"
