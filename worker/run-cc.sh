#!/bin/sh
# Per-exec Claude Code runner for the long-lived worker container.
#
# The worker container is bootstrapped once per session by `worker-run.sh`
# (clone + checkout + restore .claude.json + sleep infinity). Each turn
# the host invokes this script via `docker exec -e PROMPT=...
# -e MODE=build|scout <container> /usr/local/bin/run-cc.sh`. We do NOT
# re-clone — the workspace is reused across turns. Pre-exec hygiene
# (git fetch + reset --hard) gets us back to a known-good tree even
# if a prior turn left things dirty.
#
# Output contract is identical to the legacy single-shot worker-run.sh
# so the host's stream-json + USERNODE_* parser doesn't change:
#   __USERNODE_PHASE__  <phase>
#   __USERNODE_RESULT__ cc_exit=N ahead=N sha=… push_ok=N mode=…
#   __USERNODE_WARN__   <msg>
#   __USERNODE_ERROR__  <msg>
#
# Required env (passed via -e on `docker exec`):
#   PROMPT, BRANCH
# Optional env:
#   MODE                       build (default) | scout
#   MODEL                      default: claude-sonnet-4-6
#   COMMIT_MSG                 default: "Changes via Usernode"
#   CLAUDE_RESUME_SESSION_ID   if set, passes `--resume <id>` to claude
#   PAT                        re-asserted into the credential helper in
#                              case the warm container's git config got
#                              wiped (defensive — harmless no-op if not).

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

: "${PROMPT:?PROMPT required}"
: "${BRANCH:?BRANCH required}"
: "${MODE:=build}"
: "${MODEL:=claude-sonnet-4-6}"
: "${COMMIT_MSG:=Changes via Usernode}"
: "${PAT:=}"
: "${CLAUDE_RESUME_SESSION_ID:=}"

cd /home/node/workspace || die "no /home/node/workspace"

# Re-assert the credential helper. The warm wrapper sets it up at
# bootstrap; this is defensive in case the .git/config was perturbed.
if [ -n "$PAT" ] && ! git config --get credential.helper >/dev/null 2>&1; then
  git config credential.helper \
    "!f() { echo username=x-access-token; echo password=$PAT; }; f"
fi

# Pre-exec hygiene: every turn starts from a known-good tree. Pulls in
# anything pushed by a parallel turn / merge bot since we last ran, and
# discards any uncommitted state from a prior turn that didn't get
# committed (rare, but worth defending against).
echo "__USERNODE_PHASE__ refresh"
if ! git fetch origin --quiet 2>&1; then
  echo "__USERNODE_WARN__ git fetch failed; continuing with local state"
fi
if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  git reset --hard "origin/$BRANCH" --quiet 2>&1 || \
    echo "__USERNODE_WARN__ git reset failed"
elif [ "$MODE" = "build" ]; then
  # Branch missing upstream after PR merge → unrecoverable for build mode.
  # Scout mode can still run against the local checkout, so we don't bail.
  die "branch missing upstream: origin/$BRANCH"
fi

# In scout mode we restrict CC to read-only tools (Read/Glob/Grep) so
# the spec-stage's "scout" call can't accidentally edit the repo.
if [ "$MODE" = "scout" ]; then
  PERMISSION_FLAGS="--permission-mode plan"
else
  PERMISSION_FLAGS="--dangerously-skip-permissions"
fi

# stream-json emits one JSON object per line. The host parses this via
# the docker-exec child's stdout (long-lived path) or `docker logs -f`
# (legacy single-shot path) — same pipeline, different transport.
if [ -n "$CLAUDE_RESUME_SESSION_ID" ]; then
  echo "__USERNODE_PHASE__ claude (resume $CLAUDE_RESUME_SESSION_ID, mode $MODE)"
  claude --print $PERMISSION_FLAGS --verbose \
    --resume "$CLAUDE_RESUME_SESSION_ID" \
    --model "$MODEL" --output-format stream-json -p "$PROMPT"
  CC_EXIT=$?
  if [ "$CC_EXIT" -ne 0 ]; then
    echo "__USERNODE_WARN__ resume failed (exit $CC_EXIT); retrying fresh"
    claude --print $PERMISSION_FLAGS --verbose \
      --model "$MODEL" --output-format stream-json -p "$PROMPT"
    CC_EXIT=$?
  fi
else
  echo "__USERNODE_PHASE__ claude (mode $MODE)"
  claude --print $PERMISSION_FLAGS --verbose \
    --model "$MODEL" --output-format stream-json -p "$PROMPT"
  CC_EXIT=$?
fi

if [ "$MODE" = "scout" ]; then
  # Read-only run: no commit, no push. The host pulls scout output out
  # of stream-json's `result` event and writes it into spec_md.
  echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 sha= push_ok=0 mode=scout"
  exit "$CC_EXIT"
fi

echo "__USERNODE_PHASE__ commit"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$COMMIT_MSG" || echo "__USERNODE_WARN__ commit failed"
fi

echo "__USERNODE_PHASE__ push"
PUSH_OK=0
if git push -u origin HEAD 2>&1; then
  PUSH_OK=1
else
  echo "__USERNODE_WARN__ push failed"
fi

git fetch origin main --quiet 2>/dev/null || true
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=$AHEAD sha=$SHA push_ok=$PUSH_OK mode=build"
exit "$CC_EXIT"
