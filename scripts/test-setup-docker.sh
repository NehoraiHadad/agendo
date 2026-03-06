#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---dev}"

echo "Building setup test image (mode: $MODE)..."
docker build -f scripts/Dockerfile.setup-test \
  --build-arg SETUP_MODE="$MODE" \
  --network host \
  -t agendo-setup-test .

echo "Running setup test..."
docker run --rm --network host agendo-setup-test
