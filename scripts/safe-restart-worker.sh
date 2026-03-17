#!/usr/bin/env bash
# safe-restart-worker.sh
#
# Safely restarts agendo-worker, even when called FROM an agent session
# running on that very worker.
#
# THE PROBLEM
# -----------
# Running `pm2 restart agendo-worker` from inside a session kills the agent
# mid-turn. The auto-resume logic re-enqueues the session, the agent wakes up,
# tries the same restart, and loops forever.
#
# THE FIX
# -------
# Before restarting, this script sets auto_resume_count to 999 for the calling
# session (identified by $AGENDO_SESSION_ID). The re-enqueue logic sees
# count > MAX (3) and skips auto-resume. The session stays idle. The user (or
# agent in another session) can manually continue it later.
#
# USAGE
# -----
#   ./scripts/safe-restart-worker.sh              # build + restart
#   ./scripts/safe-restart-worker.sh --no-build   # restart only (skip build)
#   ./scripts/safe-restart-worker.sh --force      # alias for --no-build
#
# ENVIRONMENT
#   AGENDO_SESSION_ID   — set automatically inside agent sessions
#   DATABASE_URL        — PostgreSQL connection string

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DO_BUILD=true

for arg in "$@"; do
  case "$arg" in
    --no-build|--force) DO_BUILD=false ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Step 1: If running inside an agent session, prevent auto-resume
if [ -n "${AGENDO_SESSION_ID:-}" ]; then
  echo "⚠ Running inside session $AGENDO_SESSION_ID — disabling auto-resume..."

  if [ -z "${DATABASE_URL:-}" ]; then
    # Try to load from .env.local
    if [ -f "$PROJECT_DIR/.env.local" ]; then
      DATABASE_URL=$(grep '^DATABASE_URL=' "$PROJECT_DIR/.env.local" | cut -d= -f2- | tr -d '"' | tr -d "'")
    fi
  fi

  if [ -n "${DATABASE_URL:-}" ]; then
    psql "$DATABASE_URL" -q -c \
      "UPDATE sessions SET auto_resume_count = 999 WHERE id = '$AGENDO_SESSION_ID';" \
      2>/dev/null || echo "⚠ Failed to update auto_resume_count (non-fatal)"
    echo "✓ Auto-resume disabled for this session"
  else
    echo "⚠ DATABASE_URL not found — cannot disable auto-resume. Proceeding anyway."
  fi
else
  echo "ℹ Not running inside an agent session (no AGENDO_SESSION_ID)"
fi

# Step 2: Build worker (unless --no-build)
if [ "$DO_BUILD" = true ]; then
  echo "Building worker..."
  cd "$PROJECT_DIR"
  pnpm worker:build 2>&1 | tail -3
  echo "✓ Worker built"
fi

# Step 3: Restart worker
echo "Restarting agendo-worker..."
pm2 restart agendo-worker --update-env 2>&1 | tail -3
pm2 save 2>&1 | tail -1

echo "✓ Worker restarted successfully"
