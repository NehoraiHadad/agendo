#!/usr/bin/env bash
# safe-restart-worker.sh
#
# Safely restarts agendo-worker, even when called FROM an agent session
# running on that very worker.
#
# HOW IT WORKS
# ------------
# When called from inside an agent session ($AGENDO_SESSION_ID is set),
# the script writes a marker file listing the calling session's ID.
# On cold start, the zombie-reconciler reads this file and uses a smarter
# resumePrompt that tells the agent "the restart succeeded — do NOT restart
# again". This prevents the infinite restart loop without blocking auto-resume.
#
# For sessions NOT in the marker file (other active sessions at the time of
# restart), the zombie-reconciler uses the standard "continue where you left
# off" prompt — which is correct because those sessions weren't trying to
# restart anything.
#
# USAGE
# -----
#   ./scripts/safe-restart-worker.sh              # build + restart
#   ./scripts/safe-restart-worker.sh --no-build   # restart only (skip build)
#   ./scripts/safe-restart-worker.sh --force      # alias for --no-build
#
# ENVIRONMENT
#   AGENDO_SESSION_ID   — set automatically inside agent sessions

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MARKER_FILE="/tmp/agendo-restart-marker.json"

DO_BUILD=true

for arg in "$@"; do
  case "$arg" in
    --no-build|--force) DO_BUILD=false ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Step 1: If running inside an agent session, write marker file
if [ -n "${AGENDO_SESSION_ID:-}" ]; then
  echo "Writing restart marker for session $AGENDO_SESSION_ID"
  echo "{\"sessionId\":\"$AGENDO_SESSION_ID\",\"ts\":$(date +%s)}" > "$MARKER_FILE"
  echo "✓ Marker written: $MARKER_FILE"
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
