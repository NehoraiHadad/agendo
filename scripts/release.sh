#!/usr/bin/env bash
# release.sh — Bump version, update CHANGELOG, create git tag.
#
# Usage:
#   ./scripts/release.sh patch          # 0.1.0 → 0.1.1
#   ./scripts/release.sh minor          # 0.1.0 → 0.2.0
#   ./scripts/release.sh major          # 0.1.0 → 1.0.0
#   ./scripts/release.sh minor --push   # bump + push to remote
#
# Requires: git, node, jq
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHANGELOG="$PROJECT_ROOT/CHANGELOG.md"
PACKAGE_JSON="$PROJECT_ROOT/package.json"

# Colours
if [ -t 1 ]; then
  RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
  CYAN='\033[0;36m' BOLD='\033[1m' NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' NC=''
fi

info()  { echo -e "${GREEN}[release]${NC} $*"; }
warn()  { echo -e "${YELLOW}[release]${NC} $*"; }
err()   { echo -e "${RED}[release]${NC} $*" >&2; }
bold()  { echo -e "${BOLD}$*${NC}"; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
BUMP_TYPE="${1:-}"
PUSH=false

for arg in "$@"; do
  case "$arg" in
    --push) PUSH=true ;;
  esac
done

if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo ""
  bold "Agendo Release Script"
  echo ""
  echo "Usage: $0 <patch|minor|major> [--push]"
  echo ""
  echo "  patch   Increment patch version (bug fixes)"
  echo "  minor   Increment minor version (new features)"
  echo "  major   Increment major version (breaking changes)"
  echo "  --push  Push commit and tag to origin after creating"
  echo ""
  exit 1
fi

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
cd "$PROJECT_ROOT"

# Ensure we're in the right directory
if ! jq -r '.name' "$PACKAGE_JSON" 2>/dev/null | grep -q '^agendo$'; then
  err "Not in the agendo project directory. Aborting."
  exit 1
fi

# Check for clean working tree
if [ -n "$(git status --porcelain)" ]; then
  err "Working tree is dirty. Commit or stash changes first."
  git status --short
  exit 1
fi

# Ensure we have the required tools
for cmd in git node jq; do
  if ! command -v "$cmd" &>/dev/null; then
    err "Required command '$cmd' not found."
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Calculate versions
# ---------------------------------------------------------------------------
CURRENT_VERSION=$(jq -r '.version' "$PACKAGE_JSON")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW_VERSION}"
DATE=$(date +%Y-%m-%d)

echo ""
bold "Agendo Release"
echo ""
info "Current version: ${CYAN}v${CURRENT_VERSION}${NC}"
info "New version:     ${CYAN}${TAG}${NC} (${BUMP_TYPE})"
echo ""

# ---------------------------------------------------------------------------
# Generate changelog entry
# ---------------------------------------------------------------------------
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..HEAD"
  info "Changelog range: ${PREV_TAG} → HEAD"
else
  RANGE="HEAD"
  info "Changelog range: all commits (no previous tag)"
fi

# Collect commits grouped by conventional commit type
FEATURES=""
FIXES=""
REFACTORS=""
DOCS=""
CHORES=""
OTHER=""

while IFS= read -r line; do
  HASH="${line%% *}"
  MSG="${line#* }"
  SHORT_HASH="${HASH:0:7}"

  case "$MSG" in
    feat:*|feat\(*) FEATURES+=$'\n'"- ${MSG#feat: } (${SHORT_HASH})" ;;
    fix:*|fix\(*)   FIXES+=$'\n'"- ${MSG#fix: } (${SHORT_HASH})" ;;
    refactor:*|refactor\(*) REFACTORS+=$'\n'"- ${MSG#refactor: } (${SHORT_HASH})" ;;
    docs:*|docs\(*) DOCS+=$'\n'"- ${MSG#docs: } (${SHORT_HASH})" ;;
    chore:*|chore\(*) CHORES+=$'\n'"- ${MSG#chore: } (${SHORT_HASH})" ;;
    release:*)      ;; # Skip release commits
    *)              OTHER+=$'\n'"- ${MSG} (${SHORT_HASH})" ;;
  esac
done < <(git log "$RANGE" --oneline --no-merges 2>/dev/null || true)

# Build changelog entry
ENTRY="## [${NEW_VERSION}] - ${DATE}"
ENTRY+=$'\n'

[ -n "$FEATURES" ]  && ENTRY+=$'\n'"### Features${FEATURES}"$'\n'
[ -n "$FIXES" ]     && ENTRY+=$'\n'"### Bug Fixes${FIXES}"$'\n'
[ -n "$REFACTORS" ] && ENTRY+=$'\n'"### Refactoring${REFACTORS}"$'\n'
[ -n "$DOCS" ]      && ENTRY+=$'\n'"### Documentation${DOCS}"$'\n'
[ -n "$CHORES" ]    && ENTRY+=$'\n'"### Chores${CHORES}"$'\n'
[ -n "$OTHER" ]     && ENTRY+=$'\n'"### Other${OTHER}"$'\n'

# If no commits found, add a placeholder
if [ -z "$FEATURES" ] && [ -z "$FIXES" ] && [ -z "$REFACTORS" ] && \
   [ -z "$DOCS" ] && [ -z "$CHORES" ] && [ -z "$OTHER" ]; then
  ENTRY+=$'\n'"- Release ${TAG}"$'\n'
fi

# ---------------------------------------------------------------------------
# Update CHANGELOG.md
# ---------------------------------------------------------------------------
if [ -f "$CHANGELOG" ]; then
  # Insert new entry after the "# Changelog" header
  TEMP=$(mktemp)
  {
    head -1 "$CHANGELOG"
    echo ""
    echo "$ENTRY"
    tail -n +2 "$CHANGELOG"
  } > "$TEMP"
  mv "$TEMP" "$CHANGELOG"
  info "Updated CHANGELOG.md"
else
  {
    echo "# Changelog"
    echo ""
    echo "$ENTRY"
  } > "$CHANGELOG"
  info "Created CHANGELOG.md"
fi

# ---------------------------------------------------------------------------
# Update package.json version
# ---------------------------------------------------------------------------
TEMP=$(mktemp)
jq --arg v "$NEW_VERSION" '.version = $v' "$PACKAGE_JSON" > "$TEMP"
mv "$TEMP" "$PACKAGE_JSON"
info "Updated package.json version to ${NEW_VERSION}"

# ---------------------------------------------------------------------------
# Commit and tag
# ---------------------------------------------------------------------------
git add "$PACKAGE_JSON" "$CHANGELOG"
git commit -m "release: v${NEW_VERSION}"
info "Created commit: release: v${NEW_VERSION}"

git tag -a "$TAG" -m "Release ${TAG}"
info "Created tag: ${TAG}"

# ---------------------------------------------------------------------------
# Push (optional)
# ---------------------------------------------------------------------------
if [ "$PUSH" = true ]; then
  info "Pushing to origin..."
  git push origin
  git push origin "$TAG"
  info "Pushed commit and tag to origin"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
bold "Release ${TAG} complete!"
echo ""
echo "  Version:   v${CURRENT_VERSION} → ${TAG}"
echo "  Changelog: $(wc -l < "$CHANGELOG") lines"
echo "  Tag:       ${TAG}"
echo ""

if [ "$PUSH" = false ]; then
  echo "  To push:   git push origin && git push origin ${TAG}"
  echo "  Or re-run: $0 ${BUMP_TYPE} --push"
fi
echo ""
