#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--dev|--prod|--ps1|--all]"
  echo ""
  echo "  --dev   Run bash setup.sh stages only (dev mode) [default]"
  echo "  --prod  Run bash setup.sh stages only (prod mode)"
  echo "  --ps1   Run PowerShell install.ps1 stages only"
  echo "  --all   Run all stages (bash + PowerShell)"
  exit 1
}

MODE="${1:---dev}"
RUN_BASH=false
RUN_PS1=false
SETUP_MODE="--dev"

case "$MODE" in
  --dev)
    RUN_BASH=true
    SETUP_MODE="--dev"
    ;;
  --prod)
    RUN_BASH=true
    SETUP_MODE="--prod"
    ;;
  --ps1|--windows)
    RUN_PS1=true
    ;;
  --all)
    RUN_BASH=true
    RUN_PS1=true
    SETUP_MODE="--dev"
    ;;
  --help|-h)
    usage
    ;;
  *)
    echo "Unknown option: $MODE"
    usage
    ;;
esac

if $RUN_BASH; then
  echo "=== Building bash setup test stages (mode: $SETUP_MODE) ==="
  docker build -f scripts/Dockerfile.setup-test \
    --target full-test \
    --build-arg SETUP_MODE="$SETUP_MODE" \
    --network host \
    -t agendo-setup-test:bash .

  echo "=== Running bash prereq test ==="
  docker build -f scripts/Dockerfile.setup-test \
    --target prereq-test \
    --network host \
    -t agendo-setup-test:prereq .

  echo "=== Running bash full test ==="
  docker run --rm --network host agendo-setup-test:bash
fi

if $RUN_PS1; then
  echo "=== Building PS1 prereq test stage ==="
  docker build -f scripts/Dockerfile.setup-test \
    --target ps1-prereq-test \
    --network host \
    -t agendo-setup-test:ps1-prereq .

  echo "=== Building PS1 full test stage ==="
  docker build -f scripts/Dockerfile.setup-test \
    --target ps1-full-test \
    --network host \
    -t agendo-setup-test:ps1-full .

  echo "=== Running PS1 full test ==="
  docker run --rm --network host agendo-setup-test:ps1-full
fi

echo "=== All requested tests passed ==="
