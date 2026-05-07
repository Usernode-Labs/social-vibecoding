#!/bin/sh
# Usernode worker entrypoint.
#
# Runs the full CC pipeline (clone → claude → commit → push) autonomously
# inside the container so the host server can die / restart at any moment
# without killing in-flight coding work. All output goes to stdout; the
# host server tails it via `docker logs -f` and parses:
#   - stream-json events emitted by `claude` itself
#   - __USERNODE_PHASE__  lines (human-readable phase transitions)
#   - __USERNODE_RESULT__ line (final kv-pairs the server needs)
#   - __USERNODE_WARN__   / __USERNODE_ERROR__ lines
#
# The container's exit code mirrors the CC exit code. The container stays
# exited (but not removed) so the host can re-read logs after any restart.
#
# Required env (all set via -e on `docker run`):
#   CLONE_URL            git clone URL with embedded creds
#   BRANCH               branch name to check out / push
#   PROMPT               full Claude Code prompt (multi-line ok via -e)
#   ANTHROPIC_API_KEY    forwarded to `claude`
# Optional env:
#   MODEL                default: claude-sonnet-4-6
#   COMMIT_MSG           default: "Changes via Usernode"
#   PAT                  GitHub PAT used for the push credential helper.

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

: "${CLONE_URL:?CLONE_URL required}"
: "${BRANCH:?BRANCH required}"
: "${PROMPT:?PROMPT required}"
: "${MODEL:=claude-sonnet-4-6}"
: "${COMMIT_MSG:=Changes via Usernode}"
: "${PAT:=}"
: "${CLAUDE_RESUME_SESSION_ID:=}"
# MODE selects what the worker is here to do:
#   build (default) - the original CC pipeline; CC may edit files, then we
#                     git add + commit + push, and emit ahead/sha so the
#                     host can rebuild staging.
#   scout           - read-only investigation. CC runs in --permission-mode
#                     plan (Read/Glob/Grep only, no edits, no commits). The
#                     spec stage uses this to draft a grounded markdown spec
#                     without touching the repo. We skip commit/push/ahead
#                     entirely; the host scrapes CC's final result text out
#                     of stream-json to populate chat_sessions.spec_md.
: "${MODE:=build}"

cd /home/node/workspace || die "no /home/node/workspace"

# Restore CC's main config file from the persistent volume if needed.
#
# CC stores conversation history under ~/.claude/ (which we mount as a
# named volume so it survives container churn) but its primary settings
# file lives at ~/.claude.json — a SIBLING of that directory, NOT a
# child. That file is on the container filesystem, so a fresh container
# starts without it and CC prints "Claude configuration file not found"
# warnings on every subsequent turn. CC does back the file up to
# ~/.claude/backups/.claude.json.backup.<ts> (which IS in the volume),
# so we just need to restore the most recent backup at startup.
if [ ! -f /home/node/.claude.json ]; then
  LATEST_BACKUP="$(ls -1t /home/node/.claude/backups/.claude.json.backup.* 2>/dev/null | head -n1 || true)"
  if [ -n "$LATEST_BACKUP" ] && [ -f "$LATEST_BACKUP" ]; then
    cp "$LATEST_BACKUP" /home/node/.claude.json \
      && echo "__USERNODE_PHASE__ restored .claude.json from backup" \
      || echo "__USERNODE_WARN__ failed to restore .claude.json"
  fi
fi

echo "__USERNODE_PHASE__ clone"
# Clone into the current (empty) directory. Use a shallow-ish default;
# full history is unnecessary for short-lived dev sessions.
git clone "$CLONE_URL" . 2>&1 || die "clone failed"

echo "__USERNODE_PHASE__ checkout"
git checkout "$BRANCH" 2>/dev/null \
  || git checkout -b "$BRANCH" \
  || die "checkout failed"

if [ -n "$PAT" ]; then
  # Credential helper for the eventual `git push`. The PAT is already
  # present as an env var; this just wires it into git's auth flow.
  git config credential.helper \
    "!f() { echo username=x-access-token; echo password=$PAT; }; f"
fi

echo "__USERNODE_PHASE__ claude"
# stream-json emits one JSON object per line. The host parses this via
# `docker logs -f` to drive the "Reading foo.js" / "Editing bar.ts"
# progress ticks.
#
# When CLAUDE_RESUME_SESSION_ID is set we pass `--resume <id>` so CC
# rehydrates prior conversation context from /home/node/.claude (backed
# by a named Docker volume). If the resume fails (e.g. the session file
# was wiped) we retry once without --resume so the user still gets a
# response; the host will clear the stale id from the DB afterwards.
#
# In scout mode we replace --dangerously-skip-permissions with
# --permission-mode plan, which restricts CC to read-only tools (Read,
# Glob, Grep). This is the spec-stage's "scout" call: CC investigates
# the repo and writes prose, and is structurally prevented from editing
# anything. The mode is part of the same stream-json invocation so the
# existing log-parsing pipeline doesn't change.
if [ "$MODE" = "scout" ]; then
  PERMISSION_FLAGS="--permission-mode plan"
else
  PERMISSION_FLAGS="--dangerously-skip-permissions"
fi

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
  # Read-only run: CC was forbidden from editing, so we deliberately
  # don't try to commit or push. The host pulls scout output out of
  # stream-json's final `result` event and writes it into spec_md.
  # Emit a result line in the same format the build path uses so the
  # existing parser doesn't have to special-case anything; ahead=0 +
  # sha="" + push_ok=0 keep the build-side branches inert.
  echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 sha= push_ok=0 mode=scout"
  exit "$CC_EXIT"
fi

echo "__USERNODE_PHASE__ commit"
# Claude sometimes commits itself; in that case status is clean. Either
# way we try to flush whatever's left into a single commit.
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

# Tell the host whether the branch is ahead of main (→ staging rebuild)
# and what commit to base staging on. Use origin/main as the reference;
# see commit history for why comparing against origin/<branch> was wrong.
git fetch origin main --quiet 2>/dev/null || true
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=$AHEAD sha=$SHA push_ok=$PUSH_OK mode=build"
exit "$CC_EXIT"
