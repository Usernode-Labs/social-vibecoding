#!/bin/sh
# Usernode worker entrypoint — long-lived "warm" wrapper.
#
# The container is brought up once per chat session (via `docker run`)
# with MODE=warm (the default). This script does one-time bootstrap —
# clone the repo, check out the session's branch, restore CC's
# ~/.claude.json from the persistent volume backup — and then sits in
# `sleep infinity` waiting for the host to drive per-turn work via
# `docker exec /usr/local/bin/run-cc.sh`.
#
# The legacy single-shot pipeline (MODE=build|scout invoked directly,
# without a separate exec) is kept as a fallback so old code paths and
# rollback flows still work. In that mode we run the same per-exec
# script (run-cc.sh) inline after bootstrap and then exit, matching the
# pre-refactor behaviour.
#
# Required env (set via -e on `docker run`):
#   CLONE_URL            git clone URL with embedded creds
#   BRANCH               branch name to check out / push
#   ANTHROPIC_API_KEY    forwarded to `claude`
# Optional env:
#   MODE                 warm (default) | build | scout
#   PAT                  GitHub PAT used for the push credential helper
#   PROMPT, MODEL,       only required for legacy single-shot MODE=build|scout;
#   COMMIT_MSG,          ignored in MODE=warm.
#   CLAUDE_RESUME_SESSION_ID
#
# All output goes to stdout. The host tails it via `docker logs -f`
# during bootstrap to surface phase markers, then drives per-turn work
# through `docker exec` (whose stdout is read directly by the host).

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

: "${CLONE_URL:?CLONE_URL required}"
: "${BRANCH:?BRANCH required}"
: "${PAT:=}"
: "${MODE:=warm}"

cd /home/node/workspace || die "no /home/node/workspace"

# Restore CC's main config file from the persistent volume if needed.
#
# CC stores conversation history under ~/.claude/ (mounted as a named
# volume so it survives container churn) but its primary settings file
# lives at ~/.claude.json — a SIBLING of that directory. That file is
# on the container filesystem, so a fresh container starts without it
# and CC prints "Claude configuration file not found" warnings on every
# subsequent turn. CC backs the file up to
# ~/.claude/backups/.claude.json.backup.<ts> (which IS in the volume),
# so we restore the most recent backup at startup.
if [ ! -f /home/node/.claude.json ]; then
  LATEST_BACKUP="$(ls -1t /home/node/.claude/backups/.claude.json.backup.* 2>/dev/null | head -n1 || true)"
  if [ -n "$LATEST_BACKUP" ] && [ -f "$LATEST_BACKUP" ]; then
    cp "$LATEST_BACKUP" /home/node/.claude.json \
      && echo "__USERNODE_PHASE__ restored .claude.json from backup" \
      || echo "__USERNODE_WARN__ failed to restore .claude.json"
  fi
fi

# Bootstrap: clone the repo if the workspace is empty. Re-warming
# (after eviction) skips this because the volume isn't reused for the
# workspace — the workspace lives on container fs, so a destroyed
# container always re-clones. CC's session memory survives via the
# /home/node/.claude volume.
if [ ! -d /home/node/workspace/.git ]; then
  echo "__USERNODE_PHASE__ clone"
  git clone "$CLONE_URL" . 2>&1 || die "clone failed"

  echo "__USERNODE_PHASE__ checkout"
  git checkout "$BRANCH" 2>/dev/null \
    || git checkout -b "$BRANCH" \
    || die "checkout failed"
else
  # Defensive: another wrapper invocation against an existing checkout.
  # Should be rare — only happens if MODE=warm is invoked twice without
  # tearing down the container, which the host doesn't do.
  echo "__USERNODE_PHASE__ checkout (existing)"
  git fetch origin --quiet 2>&1 || echo "__USERNODE_WARN__ fetch failed"
  git checkout "$BRANCH" 2>/dev/null \
    || git checkout -b "$BRANCH" \
    || die "checkout failed"
fi

if [ -n "$PAT" ]; then
  # Credential helper for the eventual `git push`. The PAT is already
  # present as an env var; this wires it into git's auth flow.
  git config credential.helper \
    "!f() { echo username=x-access-token; echo password=$PAT; }; f"
fi

if [ "$MODE" = "warm" ]; then
  # Long-lived path. Wait for `docker exec /usr/local/bin/run-cc.sh`
  # invocations from the host. The phase marker tells the bootstrap
  # log-tailer the container is ready to receive work.
  echo "__USERNODE_PHASE__ warm-ready"
  exec sleep infinity
fi

# Legacy single-shot path. Hand off to the per-exec script which carries
# the actual CC + commit + push body. Identical contract to before the
# refactor; the host reads logs via `docker logs -f` until exit.
exec /usr/local/bin/run-cc.sh
