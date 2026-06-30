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
#   __USERNODE_RESULT__ cc_exit=N ahead=N behind=N sha=… push_ok=N mode=… [sync_result=…]
#   __USERNODE_WARN__   <msg>
#   __USERNODE_ERROR__  <msg>
#
# Required env (passed via -e on `docker exec`):
#   PROMPT, BRANCH, WORKER_JWT, SESSION_ID, PLATFORM_URL
# Optional env:
#   MODE                       build (default) | scout | sync
#   MODEL                      default: claude-sonnet-5
#   COMMIT_MSG                 default: "Changes via Usernode"
#   CLAUDE_RESUME_SESSION_ID   if set, passes `--resume <id>` to claude
#   PAT                        legacy back-compat — not set by the
#                              current platform. The push step uses
#                              `usernode-push` (which calls back into
#                              the platform's internal proxy), not
#                              direct `git push` with embedded creds.
#
# MODE=sync (#8): merge origin/main into the current branch and push.
#   1. git fetch origin
#   2. git reset --hard origin/$BRANCH (same hygiene as build)
#   3. git merge origin/main --no-edit
#      - clean → commit (already done by merge), push, sync_result=clean,
#        no CC invocation, no LLM spend
#      - conflict → leave conflict markers in working tree, invoke CC
#        with a resolution-only prompt, then sanity-check no markers
#        remain; commit + push if clean, abort if not
#         - resolved   = CC fixed it, push succeeded
#         - conflict   = CC failed; merge aborted, branch unchanged
#   Sync turns intentionally don't refresh CC's --resume session id —
#   they're a side-effect operation and shouldn't blow CC's main
#   conversation context.

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

: "${PROMPT:?PROMPT required}"
: "${BRANCH:?BRANCH required}"
: "${WORKER_JWT:?WORKER_JWT required}"
: "${SESSION_ID:?SESSION_ID required}"
: "${PLATFORM_URL:?PLATFORM_URL required}"
: "${MODE:=build}"
: "${MODEL:=claude-sonnet-5}"
: "${COMMIT_MSG:=Changes via Usernode}"
: "${PAT:=}"
: "${CLAUDE_RESUME_SESSION_ID:=}"
: "${BROWSER_MCP_CONFIG:=/home/node/.usernode-mcp.json}"

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
elif [ "$MODE" = "build" ] || [ "$MODE" = "sync" ]; then
  # Branch missing upstream after PR merge → unrecoverable for build/sync.
  # Scout mode can still run against the local checkout, so we don't bail.
  die "branch missing upstream: origin/$BRANCH"
fi

# ── MODE=sync ─────────────────────────────────────────────────────────
# Merge origin/main into the current branch. Try clean merge first; if
# it conflicts, hand the conflicted tree to CC with a tight prompt.
# We deliberately do NOT pass --resume here — sync is bookkeeping, not
# part of the conversation history.
if [ "$MODE" = "sync" ]; then
  echo "__USERNODE_PHASE__ sync_fetch_main"
  git fetch origin main --quiet 2>&1 || \
    echo "__USERNODE_WARN__ fetch origin main failed"

  # Quick precheck — if we're already up to date, there's nothing to do
  # and we want to skip CC entirely.
  BEHIND_NOW=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
  if [ "$BEHIND_NOW" = "0" ]; then
    AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
    SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
    echo "__USERNODE_RESULT__ cc_exit=0 ahead=$AHEAD behind=0 sha=$SHA push_ok=1 mode=sync sync_result=already_synced"
    exit 0
  fi

  # #361: comma-delimited list of files that conflicted on this sync.
  # Captured at conflict-detection time (below) and surfaced on every
  # __USERNODE_RESULT__ line so the platform can persist which files
  # conflicted — even on the resolved path, where the index is clean by
  # the time we emit. Empty for a clean merge.
  CONFLICT_FILES_CSV=""

  echo "__USERNODE_PHASE__ sync_merge"
  # `git merge origin/main` produces a merge commit on clean success
  # and leaves the tree dirty on conflict. We let it fail-non-zero
  # without `set -e` here on purpose.
  if git merge origin/main --no-edit -m "Merge origin/main via Usernode sync" 2>&1; then
    # Clean merge → already committed by `git merge`.
    SYNC_RESULT="clean"
  else
    # Conflict path. Hand off to CC.
    echo "__USERNODE_PHASE__ sync_conflict_cc"
    CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
    # Comma-delimited (no spaces) so it rides cleanly on the
    # space-delimited __USERNODE_RESULT__ key/value line.
    CONFLICT_FILES_CSV=$(git diff --name-only --diff-filter=U 2>/dev/null | paste -sd, - | sed 's/,$//')
    SYNC_PROMPT="A merge of origin/main into branch '$BRANCH' produced conflicts. The conflict markers (<<<<<<<, =======, >>>>>>>) are in the working tree.

Conflicted files: $CONFLICT_FILES

Resolve every conflict marker. Preserve the intent of both sides — keep the changes from main AND keep the work-in-progress on this branch. Do NOT add features or change behavior beyond what's needed to integrate cleanly. When done, every conflict marker must be gone from every file.

Do not run git commands. I will commit and push for you after you finish editing files."

    claude --print --dangerously-skip-permissions --verbose \
      --model "$MODEL" --output-format stream-json -p "$SYNC_PROMPT"
    CC_EXIT=$?

    # Sanity check: any conflict markers left? If yes, the merge is
    # not resolvable — abort cleanly so the next attempt starts from
    # a sane state. We deliberately only check for `<<<<<<<` and
    # `>>>>>>>` (not `=======`); `=======` on its own line is a
    # legitimate markdown setext h2 underline and would false-positive
    # any spec/README that uses that style.
    if grep -rlE --exclude-dir='.git' '^(<<<<<<<|>>>>>>>)( |$)' . 2>/dev/null | grep -q .; then
      echo "__USERNODE_WARN__ CC left conflict markers; aborting merge"
      git merge --abort 2>&1 || echo "__USERNODE_WARN__ merge --abort failed"
      AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
      BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
      SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
      echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=0 mode=sync sync_result=conflict conflict_files=$CONFLICT_FILES_CSV"
      exit 0
    fi

    # CC resolved cleanly — stage everything (CC may have edited files
    # outside the conflict set as a side effect; we want them all in
    # the merge commit) and commit.
    git add -A
    if ! git commit -m "Merge origin/main via Usernode sync (Claude-resolved)" 2>&1; then
      echo "__USERNODE_WARN__ commit failed after conflict resolution"
      git merge --abort 2>&1 || true
      echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 behind=$BEHIND_NOW sha= push_ok=0 mode=sync sync_result=conflict conflict_files=$CONFLICT_FILES_CSV"
      exit 0
    fi
    SYNC_RESULT="resolved"
  fi

  # Push the merge commit (clean or resolved).
  echo "__USERNODE_PHASE__ sync_push"
  PUSH_OK=0
  if /usr/local/bin/usernode-push; then
    PUSH_OK=1
  else
    echo "__USERNODE_WARN__ push failed"
  fi

  # Re-fetch so origin/main is fresh for the behind count below.
  git fetch origin main --quiet 2>/dev/null || true
  AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
  SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  echo "__USERNODE_RESULT__ cc_exit=0 ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=$PUSH_OK mode=sync sync_result=$SYNC_RESULT conflict_files=$CONFLICT_FILES_CSV"
  exit 0
fi
# ── end MODE=sync ─────────────────────────────────────────────────────

# Scout permissions: previously `--permission-mode plan`, but plan mode
# blocks all write-flavoured Bash with a generic "Bash: error" — so the
# agent kept grinding through `git submodule update`, `gh api`, etc.,
# burning tokens on tools it didn't realise were denied. We now run
# scout with the same `--dangerously-skip-permissions` as build, but
# strip Edit/Write/NotebookEdit at the tool layer so file mutations are
# impossible regardless of what CC tries. The remaining safety nets:
#   - `git reset --hard origin/$BRANCH` at the top of every turn (above)
#     wipes any uncommitted/local commits the next turn would otherwise
#     inherit
#   - this script's MODE=scout branch (below) skips the commit/push
#     block entirely
#   - usernode-push refuses if MODE=scout (worker/usernode-push)
#   - WORKER_JWT is omitted from scout's docker exec env
#     (worker.execInWorker), so even direct `usernode-push` from CC's
#     Bash has no JWT to authenticate with against the platform proxy
# Net effect: scout has full read-only Bash + WebFetch (so it can run
# `git submodule update --init`, `gh api`, etc.) but cannot escape the
# worker container even if CC misbehaves.
if [ "$MODE" = "scout" ]; then
  PERMISSION_FLAGS="--dangerously-skip-permissions --disallowed-tools Edit Write NotebookEdit"
else
  PERMISSION_FLAGS="--dangerously-skip-permissions"
fi

# Optional in-loop browser: expose the pinned Playwright MCP server so a
# BUILD turn CAN open the app it just edited in a headless browser to catch
# render/JS errors before committing (see app-conventions.md, worker-run.sh).
# `--strict-mcp-config` makes claude load ONLY this config — never a
# `.mcp.json` an untrusted repo might carry, which under
# --dangerously-skip-permissions would otherwise auto-start arbitrary
# servers. Scout (read-only) and sync (bookkeeping) get NO browser tooling:
# the flags stay empty, so their `claude` invocations are byte-for-byte as
# before. The MCP server only spawns on claude startup; Chromium launches
# lazily on the first browser tool call, so a build turn that never reaches
# for it pays nothing.
BROWSER_MCP_FLAGS=""
if [ "$MODE" = "build" ] && [ -f "$BROWSER_MCP_CONFIG" ]; then
  BROWSER_MCP_FLAGS="--mcp-config $BROWSER_MCP_CONFIG --strict-mcp-config"
fi

# stream-json emits one JSON object per line. The host parses this via
# the docker-exec child's stdout (long-lived path) or `docker logs -f`
# (legacy single-shot path) — same pipeline, different transport.
if [ -n "$CLAUDE_RESUME_SESSION_ID" ]; then
  echo "__USERNODE_PHASE__ claude (resume $CLAUDE_RESUME_SESSION_ID, mode $MODE)"
  claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS --verbose \
    --resume "$CLAUDE_RESUME_SESSION_ID" \
    --model "$MODEL" --output-format stream-json -p "$PROMPT"
  CC_EXIT=$?
  if [ "$CC_EXIT" -ne 0 ]; then
    echo "__USERNODE_WARN__ resume failed (exit $CC_EXIT); retrying fresh"
    claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS --verbose \
      --model "$MODEL" --output-format stream-json -p "$PROMPT"
    CC_EXIT=$?
  fi
else
  echo "__USERNODE_PHASE__ claude (mode $MODE)"
  claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS --verbose \
    --model "$MODEL" --output-format stream-json -p "$PROMPT"
  CC_EXIT=$?
fi

if [ "$MODE" = "scout" ]; then
  # Read-only run: no commit, no push. The host pulls scout output out
  # of stream-json's `result` event and writes it into spec_md.
  # behind=0 because scout never modifies the tree; the real number
  # gets refreshed by the next build/sync turn.
  echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 behind=0 sha= push_ok=0 mode=scout"
  exit "$CC_EXIT"
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
  # Belt-and-suspenders: the platform-side push proxy ignores the
  # worker's local HEAD and pushes the session's canonical branch
  # from its own DB lookup, but if HEAD has drifted we likely
  # committed onto the wrong branch, so the push would push stale
  # content. Skip and surface clearly.
  echo "__USERNODE_WARN__ HEAD branch ($HEAD_BRANCH) != session branch ($BRANCH); skipping push"
elif /usr/local/bin/usernode-push; then
  PUSH_OK=1
else
  echo "__USERNODE_WARN__ push failed"
fi

git fetch origin main --quiet 2>/dev/null || true
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
# #8: how many commits this branch is behind origin/main. Drives the
# dev-chat "Sync with main" banner and the merge-time block.
BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=$PUSH_OK mode=build"
exit "$CC_EXIT"
