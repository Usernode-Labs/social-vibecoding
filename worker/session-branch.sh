# Session-branch integrity for the worker's git checkout. Sourced (not run)
# by worker-run.sh, run-cc.sh and run-codex-agent.sh, with BRANCH set and the
# workspace as the current directory. POSIX sh: the runners are /bin/sh.
#
# Each helper answers one way a build turn used to go wrong
# (usernode-bot/sheep-countrr-a08857#48):
#
#   - usernode_limit_remote_refs / usernode_fetch_session_refs: a worker's
#     clone held every member's unmerged dev/* branch, and an agent unsure
#     where its edits had gone copied another member's commit into its own
#     proposal (#34 there). The checkout now knows main and this session's
#     branch and nothing else.
#   - usernode_start_turn_on_session_branch: the pre-turn `git reset --hard`
#     moved whatever branch HEAD was on, so a turn that had switched to a
#     branch of its own kept every later turn there; and it left untracked
#     files alone, so a stopped turn's screenshots were swept into the next
#     turn's commit.
#   - usernode_settle_session_branch: a turn that committed on a branch of
#     its own (`wolf-mechanic`) was only warned about; its work never reached
#     the session branch, and recovery replayed the empty push ~1,357 times.
#   - usernode_commit_leftovers: the post-turn commit added every untracked
#     file, including what an agent had deliberately left out of its commit.

# Point `git fetch origin` at main alone, and forget any remote-tracking ref
# that is neither main nor this session's branch. The session branch is not
# in the configured refspec because a refspec naming a branch that does not
# exist yet (a fresh session, before its first push) fails the whole fetch;
# usernode_fetch_session_refs fetches it explicitly instead.
usernode_limit_remote_refs() {
  git remote get-url origin >/dev/null 2>&1 || return 1
  git config --replace-all remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main' || return 1
  git for-each-ref --format='%(refname)' refs/remotes/origin/ | while read -r ref; do
    case "$ref" in
      refs/remotes/origin/main|refs/remotes/origin/HEAD|"refs/remotes/origin/$BRANCH") ;;
      *) git update-ref -d "$ref" ;;
    esac
  done
}

# Fetch main and, when it exists on GitHub, this session's branch. A missing
# session branch is not an error here: callers decide what that means. The
# session branch is fetched even when main's fetch fails. Prints git's output
# for main's fetch; returns non-zero when that failed.
usernode_fetch_session_refs() {
  usernode_limit_remote_refs >/dev/null 2>&1 || true
  main_rc=0
  git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' 2>&1 || main_rc=1
  if [ -n "${BRANCH:-}" ]; then
    git fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" >/dev/null 2>&1 || true
  fi
  return "$main_rc"
}

# Check out this session's branch at bootstrap: the local one when the
# checkout already has it, otherwise GitHub's copy, otherwise a new branch
# from main. Spelled out because git's `checkout <name>` shorthand no longer
# finds origin's copy once the fetch refspec names main alone.
usernode_checkout_session_branch() {
  if git rev-parse --quiet --verify "refs/heads/$BRANCH" >/dev/null; then
    git checkout --quiet "$BRANCH" 2>&1
  elif git rev-parse --quiet --verify "refs/remotes/origin/$BRANCH" >/dev/null; then
    git checkout --quiet -b "$BRANCH" "refs/remotes/origin/$BRANCH" 2>&1
  else
    git checkout --quiet -b "$BRANCH" 2>&1
  fi
}

# Start a turn on the session branch exactly as GitHub has it: check the
# branch out (whatever HEAD was on before) at origin's commit. With
# `clean_untracked`, also delete untracked files an earlier turn left behind;
# ignored files (node_modules, .env) stay. Branches an earlier turn created
# are left in place, so their commits stay recoverable.
usernode_start_turn_on_session_branch() {
  git checkout --quiet --force -B "$BRANCH" "refs/remotes/origin/$BRANCH" 2>&1 || return 1
  if [ "${1:-}" = "clean_untracked" ]; then
    git clean --quiet -fd 2>&1 || echo "__USERNODE_WARN__ git clean failed"
  fi
  return 0
}

# After the agent has finished: make sure its work is on the session branch.
#   - HEAD on the session branch: nothing to do.
#   - HEAD on another branch (or detached) that grew from the session
#     branch: move the session branch up to HEAD and check it out, keeping
#     the working tree. That is the work of this turn.
#   - Anything else (HEAD on a line that does not contain the session
#     branch, such as another member's branch): leave it where it is, set
#     USERNODE_BRANCH_MISMATCH and return 1. Nothing is committed or pushed.
usernode_settle_session_branch() {
  USERNODE_BRANCH_MISMATCH=""
  current=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  [ "$current" = "$BRANCH" ] && return 0
  label=${current:-"a detached HEAD at $(git rev-parse --short HEAD 2>/dev/null)"}
  if git rev-parse --quiet --verify "refs/heads/$BRANCH" >/dev/null \
      && git merge-base --is-ancestor "refs/heads/$BRANCH" HEAD 2>/dev/null \
      && git branch --force "$BRANCH" HEAD >/dev/null 2>&1 \
      && git checkout --quiet "$BRANCH" 2>/dev/null; then
    echo "__USERNODE_WARN__ The agent committed on $label instead of the session branch $BRANCH; its commits were moved onto $BRANCH."
    return 0
  fi
  USERNODE_BRANCH_MISMATCH=1
  echo "__USERNODE_WARN__ The agent ended on $label, which does not build on the session branch $BRANCH; nothing from this turn was committed or pushed."
  return 1
}

# Commit what the agent left uncommitted. $1 is HEAD's commit when the agent
# started, $2 the commit message. An agent that committed during the turn
# has already chosen what belongs in the change, so only its edits to
# tracked files are added: new files it left out (screenshots, logs, build
# output) stay out and are named in a warning. An agent that committed
# nothing, like the Homeroom bot's, which is told the harness commits for
# it, has its whole working tree committed as before.
usernode_commit_leftovers() {
  [ -n "$(git status --porcelain)" ] || return 0
  if [ -n "${1:-}" ] && [ "$(git rev-parse HEAD 2>/dev/null)" != "$1" ]; then
    git add --update
    left=$(git ls-files --others --exclude-standard | head -n 20 | tr '\n' ' ')
    if [ -n "$left" ]; then
      echo "__USERNODE_WARN__ Left out of the commit (new files the agent did not commit): $left"
    fi
  else
    git add -A
  fi
  git diff --cached --quiet && return 0
  git commit -m "$2" || echo "__USERNODE_WARN__ commit failed"
}
