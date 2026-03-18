#!/usr/bin/env bash
# safe-restart-agendo.sh
#
# Restarts the agendo Next.js app (PM2 name: "agendo").
#
# If active agent sessions exist, their MCP connection will drop and the agent
# CLI will exit with a non-zero code. The worker's auto-resume logic
# (handleReEnqueue in session-control-handlers.ts) detects the mid-turn
# interruption and automatically re-enqueues those sessions — no special
# handling needed here.
#
# USAGE
# -----
#   ./scripts/safe-restart-agendo.sh
#   ./scripts/safe-restart-agendo.sh --force    # (accepted for backward compat, same behavior)

set -euo pipefail

echo "Restarting agendo..."
pm2 restart agendo --update-env
pm2 save --force >/dev/null 2>&1 || true
echo "✓ agendo restarted. Active sessions will auto-resume."
