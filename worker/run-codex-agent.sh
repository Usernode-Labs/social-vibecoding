#!/bin/sh
# Per-exec Codex (codex_openrouter) runner for the long-lived worker
# container. Sibling of run-cc.sh — identical __USERNODE_* output contract
# so the host's journal consumer (worker.js parseLine) is unchanged:
#   __USERNODE_PHASE__  <phase>
#   __USERNODE_RESULT__ cc_exit=N ahead=N behind=N sha=… push_ok=N mode=… \
#                       agent_backend=codex_openrouter agent_model=… \
#                       agent_thread_id=… agent_exit=N
#   __USERNODE_WARN__   <msg>
#   __USERNODE_ERROR__  <msg>
#
# The raw OpenRouter key NEVER enters this container. Codex is configured
# to point at the Usernode relay (USERNODE_AGENT_RELAY) and authenticates
# with the per-turn scoped token in USERNODE_AGENT_TOKEN. The relay
# decrypts the user key server-side.
#
# Required env (passed via -e on `docker exec`):
#   PROMPT_FILE, BRANCH, WORKER_JWT, SESSION_ID, PLATFORM_URL,
#   USERNODE_AGENT_TOKEN, USERNODE_AGENT_RELAY, AGENT_MODEL
# Optional:
#   MODE (build|scout), AGENT_REASONING_EFFORT, AGENT_THREAD_ID (resume),
#   COMMIT_MSG, TURN_UUID

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

: "${PROMPT_FILE:?PROMPT_FILE required}"
[ -s "$PROMPT_FILE" ] || die "prompt file missing or empty: $PROMPT_FILE"
: "${BRANCH:?BRANCH required}"
: "${WORKER_JWT:?WORKER_JWT required}"
: "${SESSION_ID:?SESSION_ID required}"
: "${PLATFORM_URL:?PLATFORM_URL required}"
: "${USERNODE_AGENT_TOKEN:?USERNODE_AGENT_TOKEN required}"
: "${USERNODE_AGENT_RELAY:?USERNODE_AGENT_RELAY required}"
: "${AGENT_MODEL:?AGENT_MODEL required}"
: "${MODE:=build}"
: "${AGENT_REASONING_EFFORT:=}"
: "${AGENT_THREAD_ID:=}"
: "${COMMIT_MSG:=Changes via Usernode (Codex)}"
: "${TURN_UUID:=}"

cd /home/node/workspace || die "no /home/node/workspace"

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

# Platform-owned Codex config. The relay base URL is the platform's
# internal endpoint; the env_key USERNODE_AGENT_TOKEN carries the scoped
# bearer. Multi-agent is disabled in the first release.
CODEX_HOME=/home/node/.codex
mkdir -p "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<EOF
model_provider = "usernode_openrouter"
model = "$AGENT_MODEL"
${AGENT_REASONING_EFFORT:+model_reasoning_effort = "$AGENT_REASONING_EFFORT"}

[agents]
enabled = false

[model_providers.usernode_openrouter]
name = "Usernode OpenRouter"
base_url = "$USERNODE_AGENT_RELAY"
wire_api = "responses"
env_key = "USERNODE_AGENT_TOKEN"
EOF
export USERNODE_AGENT_TOKEN
# Keep the token out of any subshell env that agent code controls beyond
# the codex process itself — it is already scoped to this turn.
export OPENROUTER_API_KEY=""

# Invoke Codex non-interactively. --json emits JSON Lines the host parser
# (worker.js parseLine → codex-openrouter.js normalizeCodexLine) handles.
#
# Sandbox (review F1): build turns MUST be workspace-write (the default
# read-only sandbox makes commit/push a no-op). Scout stays read-only.
# Non-interactive approval is via -c approval_policy=never (matches the
# pinned 0.146.0 config keys). --profile is NOT valid on `resume` so it
# is only passed to the fresh `exec` form.
CODEX_EXIT=0
AGENT_THREAD_OUT="$AGENT_THREAD_ID"
SANDBOX_FLAG="-s $([ "$MODE" = "build" ] && echo workspace-write || echo read-only)"
APPROVAL_FLAG='-c approval_policy=never'
# Tee the raw output so we can extract the thread id from thread.started
# (review F5): the host's parseLine already sees it, but persisting it
# in __USERNODE_RESULT__ lets the recovery path re-resume.
TMP_JSONL=$(mktemp /home/node/.usernode/turn-codex-XXXX.jsonl 2>/dev/null || mktemp)
if [ -n "$AGENT_THREAD_ID" ]; then
  echo "__USERNODE_PHASE__ codex (resume $AGENT_THREAD_ID, mode $MODE)"
  cat "$PROMPT_FILE" | codex exec resume "$AGENT_THREAD_ID" - --json $APPROVAL_FLAG 2>&1 | tee "$TMP_JSONL"
  CODEX_EXIT=${PIPESTATUS[0]:-$?}
  if [ "$CODEX_EXIT" -ne 0 ]; then
    echo "__USERNODE_WARN__ codex resume failed (exit $CODEX_EXIT); retrying fresh"
    cat "$PROMPT_FILE" | codex exec - --json $APPROVAL_FLAG $SANDBOX_FLAG -p usernode-build 2>&1 | tee "$TMP_JSONL"
    CODEX_EXIT=${PIPESTATUS[0]:-$?}
    AGENT_THREAD_OUT=""
  fi
else
  echo "__USERNODE_PHASE__ codex (mode $MODE)"
  cat "$PROMPT_FILE" | codex exec - --json $APPROVAL_FLAG $SANDBOX_FLAG -p usernode-build 2>&1 | tee "$TMP_JSONL"
  CODEX_EXIT=${PIPESTATUS[0]:-$?}
fi

# Extract the thread id from thread.started (review F5): codex emits
# {"type":"thread.started","thread_id":"019f..."} on the first line.
# For a resume, keep the original; for a fresh turn, capture the new one.
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
