#!/usr/bin/env bash
#
# Roll the Usernode harness back to a specific git SHA.
#
# Usage (on the VPS, as the `deploy` user):
#
#   /opt/usernode-tools/rollback.sh <sha>
#
# This script is the kill-switch for self-hosting (see SELF-HOSTING.md).
# It must work when the harness is broken — when the platform process is
# crashing, when a recent migration corrupted state, when a self-app PR
# took the UI down. So it deliberately does NOT depend on:
#
#   - The platform being healthy.
#   - /opt/usernode/.git existing (the deploy workflow rsyncs without it).
#   - The GitHub Actions workflow being functional.
#   - Any network path other than github.com.
#
# It re-clones Usernode-Labs/social-vibecoding at the target SHA into a
# staging dir, rsyncs over /opt/usernode (preserving .env, runtime/, and
# data/), and runs `docker compose up -d --build`.
#
# Find a known-good SHA at:
#   https://github.com/Usernode-Labs/social-vibecoding/commits/main
#
# Quick checks before rolling:
#   grep ^GIT_SHA= /opt/usernode/.env       # current SHA
#   docker logs usernode --tail 50          # what's broken
#
# Caveats:
#   - Schema migrations are forward-only. If the rolled-back code can't
#     handle the current DB schema, the platform won't start. That's a
#     detectable failure (the container fails health checks); fix or
#     roll forward.
#   - The named volumes (caddy-runtime, caddy-data, caddy-config,
#     usernode-db-data, usernode-node-data, usernode-node-archive)
#     persist across rollback. Postgres data is preserved.
#
# This script is rsynced into /opt/usernode-tools/ by the Deploy
# workflow (which copies it from /opt/usernode/scripts/rollback.sh after
# the main rsync). The separate dir means a future deploy with a broken
# rsync can't clobber it.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  cat <<USAGE >&2
Usage: $0 <sha>

Roll the Usernode platform back to the given commit.

Find a known-good SHA at:
  https://github.com/Usernode-Labs/social-vibecoding/commits/main

Quick checks before rolling:
  grep ^GIT_SHA= /opt/usernode/.env       # current SHA
  docker logs usernode --tail 50          # what's broken
USAGE
  exit 1
fi

TARGET_SHA="$1"
REPO_URL="https://github.com/Usernode-Labs/social-vibecoding.git"
DEPLOY_DIR="/opt/usernode"
STAGING="/tmp/usernode-rollback-$$"

# Reject anything that doesn't look like a git SHA (full or short hash).
# Cheap defense against typos and accidental shell expansion.
if ! echo "$TARGET_SHA" | grep -Eq '^[0-9a-fA-F]{7,40}$'; then
  echo "Refusing: '$TARGET_SHA' does not look like a git SHA" >&2
  exit 1
fi

if [ ! -d "$DEPLOY_DIR" ]; then
  echo "Refusing: $DEPLOY_DIR does not exist (is the platform installed?)" >&2
  exit 1
fi

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "Refusing: $DEPLOY_DIR/.env missing — the rollback would leave the harness unconfigured" >&2
  exit 1
fi

CURRENT_SHA="$(grep -E '^GIT_SHA=' "$DEPLOY_DIR/.env" | cut -d= -f2- || true)"
echo "==> Current SHA: ${CURRENT_SHA:-unknown}"
echo "==> Target SHA:  $TARGET_SHA"
echo

trap 'rm -rf "$STAGING"' EXIT

echo "==> Cloning $REPO_URL..."
# Full clone (no --depth) so any historical SHA is reachable. The repo
# is small; the few extra seconds cost is the right tradeoff for a
# kill-switch — we want the SHA to resolve no matter how old it is.
git clone "$REPO_URL" "$STAGING"

cd "$STAGING"
echo "==> Checking out $TARGET_SHA..."
git checkout "$TARGET_SHA"

echo "==> Replacing $DEPLOY_DIR working tree (preserving .env, runtime/, data/)..."
# Same exclude list the Deploy workflow uses (see .github/workflows/
# deploy.yml). --delete keeps DEPLOY_DIR a faithful mirror of the
# rolled-back tree so stale files from the broken commit can't linger.
rsync -av --delete \
  --exclude=.git \
  --exclude=.github \
  --exclude=node_modules \
  --exclude=data \
  --exclude=.env \
  --exclude=.platform-env\* \
  --exclude=runtime \
  "$STAGING/" "$DEPLOY_DIR/"

echo "==> Updating GIT_SHA in .env..."
# Replace the existing GIT_SHA line in-place so the platform's version
# pill / app-version machinery reflects the rolled-back commit. If
# GIT_SHA is missing for some reason, append it.
if grep -q '^GIT_SHA=' "$DEPLOY_DIR/.env"; then
  # Use a temp file rather than `sed -i` to avoid sed-version portability issues.
  awk -v sha="$TARGET_SHA" 'BEGIN{FS=OFS="="} /^GIT_SHA=/ {$2=sha} {print}' \
    "$DEPLOY_DIR/.env" > "$DEPLOY_DIR/.env.rollback.tmp"
  mv "$DEPLOY_DIR/.env.rollback.tmp" "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
else
  echo "GIT_SHA=$TARGET_SHA" >> "$DEPLOY_DIR/.env"
fi

echo "==> Building and bringing up the harness..."
cd "$DEPLOY_DIR"
# Build is required because the platform image bakes in `COPY . .`,
# so the only way new code gets in is a rebuild.
docker compose up -d --build

echo
echo "==> Rollback complete. Now running on $TARGET_SHA."
echo "    Container status:"
docker compose ps
