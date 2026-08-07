#!/bin/sh
# Per-exec Codex (codex_openrouter) runner for the long-lived worker
# container. Sibling of run-cc.sh — identical __USERNODE_* output contract
# so the host's journal consumer (worker.js parseLine) is unchanged:
#   __USERNODE_PHASE__  <phase>
#   __USERNODE_RESULT__ cc_exit=N ... agent_backend=codex_openrouter ...
#   __USERNODE_WARN__   <msg>
#   __USERNODE_ERROR__  <msg>
#
# Direct-transport (review P0): Codex points DIRECTLY at OpenRouter and
# authenticates with the user's own key, injected per-turn on this specific
# `docker exec` as OPENROUTER_API_KEY. It is NOT persisted in the warm
# container's env/filesystem by the platform; the agent code running in this
# worker naturally sees the key, which the UI discloses. No platform relay.
#
# Required env: PROMPT_FILE, BRANCH, SESSION_ID, PLATFORM_URL,
#   OPENROUTER_API_KEY, AGENT_MODEL
# Optional: MODE (build|scout), AGENT_REASONING_EFFORT, AGENT_THREAD_ID,
#   COMMIT_MSG, TURN_UUID, OPENROUTER_API_BASE, WORKER_JWT (build-only)

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

: "${PROMPT_FILE:?PROMPT_FILE required}"
[ -s "$PROMPT_FILE" ] || die "prompt file missing or empty: $PROMPT_FILE"
: "${BRANCH:?BRANCH required}"
: "${SESSION_ID:?SESSION_ID required}"
: "${PLATFORM_URL:?PLATFORM_URL required}"
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY required}"
: "${AGENT_MODEL:?AGENT_MODEL required}"
: "${MODE:=build}"
: "${AGENT_REASONING_EFFORT:=}"
: "${AGENT_THREAD_ID:=}"
: "${COMMIT_MSG:=Changes via Usernode (Codex)}"
: "${TURN_UUID:=}"
: "${WORKER_JWT:=}"
# Scout must NEVER receive push authority (review #4): WORKER_JWT is
# required for build (to push) but must be empty for scout.
if [ "$MODE" = "build" ] && [ -z "$WORKER_JWT" ]; then
  die "WORKER_JWT required for build mode"
fi
if [ "$MODE" = "scout" ]; then
  WORKER_JWT=""
fi
export WORKER_JWT

WORKSPACE_DIR="${WORKSPACE_DIR:-/home/node/workspace}"
cd "$WORKSPACE_DIR" || die "no workspace: $WORKSPACE_DIR"

# Pre-exec hygiene: start from a known-good tree (same as run-cc.sh).
echo "__USERNODE_PHASE__ refresh"
if ! git fetch origin --quiet 2>&1; then
  echo "__USERNODE_WARN__ git fetch failed; continuing with local state"
fi
if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  git reset --hard "origin/$BRANCH" --quiet 2>&1 || \
    echo "__USERNODE_WARN__ git reset failed"
elif [ "$MODE" = "build" ]; then
  die "branch missing upstream: origin/$BRANCH"
fi

# Codex home lives INSIDE the persistent Claude volume so session/rollout
# state survives worker eviction. Export it so Codex reads the direct
# OpenRouter config and persistent rollout dir.
export CODEX_HOME="${CODEX_HOME:-/home/node/.claude/codex-home}"
mkdir -p "$CODEX_HOME"

# TOML-safe escaping (quotes/backslashes/newlines) so attacker-controlled
# model strings cannot inject extra TOML/MCP sections into config.toml.
toml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'
}
ESCAPED_MODEL=$(toml_escape "$AGENT_MODEL")
OPENROUTER_API_BASE="${OPENROUTER_API_BASE:-https://openrouter.ai/api/v1}"
ESCAPED_BASE=$(toml_escape "$OPENROUTER_API_BASE")
if [ -n "$AGENT_REASONING_EFFORT" ]; then
  ESCAPED_EFFORT=$(toml_escape "$AGENT_REASONING_EFFORT")
fi
# sandbox + approval mode; build needs workspace-write.
SANDBOX_MODE=$([ "$MODE" = "build" ] && echo workspace-write || echo read-only)

# NOTE: this heredoc is UNQUOTED so we can interpolate the escaped model/
# base/effort and the computed sandbox mode. There are NO backticks or
# $(...) in the TOML body itself — command substitution is only used on
# the interpolation lines' values, which are pre-escaped above.
cat > "$CODEX_HOME/config.toml" <<EOF
model_provider = "usernode_openrouter"
model = "$ESCAPED_MODEL"
${ESCAPED_EFFORT:+model_reasoning_effort = "$ESCAPED_EFFORT"}

sandbox_mode = "$SANDBOX_MODE"
approval_policy = "never"

[agents]
enabled = false

[model_providers.usernode_openrouter]
name = "OpenRouter"
base_url = "$ESCAPED_BASE"
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
EOF

# Export the user's key for this process only.
export OPENROUTER_API_KEY

CODEX_EXIT=0
AGENT_THREAD_OUT="$AGENT_THREAD_ID"
TMP_JSONL=$(mktemp /home/node/.usernode/turn-codex-XXXX.jsonl 2>/dev/null || mktemp)

# The prompt is fed on stdin (a detached docker exec has no inherited
# stdin). Dash has no PIPESTATUS, so we capture codex's exit code via a
# subshell that writes it to a status file, and stream codex output LIVE
# to the turn journal through tee (review P4: long turns must show tool/
# edit progress in real time, not only after codex exits). The same tee
# writes a copy to TMP_JSONL for thread-id extraction and resume-failure
# classification.

CODEX_RUN_EXIT=0
TMP_STATUS=$(mktemp /home/node/.usernode/turn-codex-status-XXXX 2>/dev/null || mktemp)

start_codex() {
  # shellcheck disable=SC2086
  ( "$@" < "$PROMPT_FILE"; echo $? > "$TMP_STATUS" ) 2>&1 | tee "$TMP_JSONL"
  CODEX_RUN_EXIT=$(cat "$TMP_STATUS")
}

if [ -n "$AGENT_THREAD_ID" ]; then
  echo "__USERNODE_PHASE__ codex (resume $AGENT_THREAD_ID, mode $MODE)"
  start_codex codex exec resume "$AGENT_THREAD_ID" - --json
  if [ "$CODEX_RUN_EXIT" -ne 0 ]; then
    # Only retry fresh for a genuinely missing/stale thread (review P4):
    # auth/credit/rate-limit/unknown failures must NOT re-run (they'd
    # repeat billed work against a partially modified tree). Decide here
    # from the error content in $TMP_JSONL (already streamed to the journal).
    if grep -qiE 'thread not found|session not found|local rollout unavailable' "$TMP_JSONL"; then
      echo "__USERNODE_WARN__ codex thread missing (exit $CODEX_RUN_EXIT); retrying fresh"
      start_codex codex exec - --json
      AGENT_THREAD_OUT=""
    else
      echo "__USERNODE_WARN__ codex resume failed (exit $CODEX_RUN_EXIT); NOT retrying fresh"
      CODEX_EXIT=$CODEX_RUN_EXIT
      AGENT_THREAD_OUT=""
      # The failed resume's output was already streamed live; emit a
      # terminal result so the host doesn't wait forever, then bail.
      echo "__USERNODE_RESULT__ cc_exit=$CODEX_RUN_EXIT ahead=0 behind=0 sha= push_ok=0 mode=$MODE agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id= agent_exit=$CODEX_RUN_EXIT"
      exit "$CODEX_RUN_EXIT"
    fi
  fi
else
  echo "__USERNODE_PHASE__ codex (mode $MODE)"
  start_codex codex exec - --json
fi
CODEX_EXIT=$CODEX_RUN_EXIT
rm -f "$TMP_STATUS" 2>/dev/null

# Extract the thread id from thread.started for resume on the next turn.
if [ -z "$AGENT_THREAD_OUT" ]; then
  EXTRACTED=$(grep -o '"type":"thread.started","thread_id":"[^"]*"' "$TMP_JSONL" | head -1 | sed 's/.*"thread_id":"//;s/"$//')
  if [ -n "$EXTRACTED" ]; then
    AGENT_THREAD_OUT="$EXTRACTED"
  fi
fi
rm -f "$TMP_JSONL" 2>/dev/null

if [ "$MODE" = "scout" ]; then
  echo "__USERNODE_PHASE__ done"
  echo "__USERNODE_RESULT__ cc_exit=$CODEX_EXIT ahead=0 behind=0 sha= push_ok=0 mode=scout agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id=$AGENT_THREAD_OUT agent_exit=$CODEX_EXIT"
  exit "$CODEX_EXIT"
fi

# A failed (non-zero) codex turn must NOT be committed or pushed — doing so
# would publish partial/incomplete work. Emit a terminal result and bail.
if [ "$CODEX_EXIT" -ne 0 ]; then
  echo "__USERNODE_WARN__ codex exited non-zero ($CODEX_EXIT); skipping commit/push"
  echo "__USERNODE_PHASE__ done"
  echo "__USERNODE_RESULT__ cc_exit=$CODEX_EXIT ahead=0 behind=0 sha= push_ok=0 mode=build agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id=$AGENT_THREAD_OUT agent_exit=$CODEX_EXIT"
  exit "$CODEX_EXIT"
fi

echo "__USERNODE_PHASE__ commit"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$COMMIT_MSG" || echo "__USERNODE_WARN__ commit failed"
fi

echo "__USERNODE_PHASE__ push"
PUSH_OK=0
HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$HEAD_BRANCH" != "$BRANCH" ]; then
  echo "__USERNODE_WARN__ HEAD branch ($HEAD_BRANCH) != session branch ($BRANCH); skipping push"
elif /usr/local/bin/usernode-push; then
  PUSH_OK=1
else
  echo "__USERNODE_WARN__ push failed"
fi

git fetch origin main --quiet 2>/dev/null || true
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

if [ "$PUSH_OK" = "1" ]; then
  echo "__USERNODE_PHASE__ done"
else
  echo "__USERNODE_PHASE__ push_failed"
fi
echo "__USERNODE_RESULT__ cc_exit=$CODEX_EXIT ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=$PUSH_OK mode=build agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id=$AGENT_THREAD_OUT agent_exit=$CODEX_EXIT"
exit "$CODEX_EXIT"
