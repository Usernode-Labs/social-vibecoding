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
#   - usernode_clone_sealed / usernode_reseal: a benchmark trial's checkout
#     held today's main, so a model replaying an old request could read the
#     answer in `git log origin/main` (a triage plan cited the later pull
#     request and its commit). See "Benchmark trials" below.

# ── Benchmark trials ────────────────────────────────────────────────────
#
# A Homeroom bot benchmark trial (src/services/bench/runner.js) replays a
# request as it stood at a past commit, on a `bench/` branch cut there. The
# platform starts its worker with USERNODE_PINNED_BASE set to that commit,
# and the checkout is then SEALED:
#
#   - it is fetched from the session branch alone (never a clone of main),
#     so the object store holds the base, its ancestors and the trial's own
#     commits, and nothing later: no tags, no other branch, no reflog entry;
#   - main and origin/main are the base, so `origin/main..HEAD` still counts
#     the trial's own commits and nothing names a later one;
#   - origin's fetch URL points at nothing, so `git fetch` and `git pull`
#     fail; it pushes to GitHub (url.<clone URL>.pushInsteadOf, which no
#     rewrite below applies to), so the platform's push proxy
#     (worker.js buildPushScript, `git push -u origin "$BRANCH"`) still
#     lands the trial's branch. A push updates origin/$BRANCH through the
#     fetch refspec, which names the session branch alone;
#   - the repository's own address on GitHub, typed out, reaches a stand-in
#     inside .git whose main is the base (url.<stand-in>.insteadOf). The
#     repository's AGENTS.md tells an agent to `git fetch
#     https://github.com/Usernode-Labs/social-vibecoding main` and check
#     that HEAD contains it. In runs 206 and 208 six platform builds did,
#     found the request already merged on today's main and stopped with
#     BLOCKED, which the benchmark counts as a failed build. The check now
#     answers "current", as it does for a live build on today's main, and
#     fetches nothing later. The stand-in borrows the checkout's objects
#     (objects/info/alternates), so nothing is copied.
#
# What this cannot stop: the worker has network access (its model provider,
# npm), and the repository is public, so a model that reaches GitHub some
# other way (its API, another spelling of the address) could still read
# later history.
USERNODE_SEALED_URL=/dev/null/no-upstream-in-a-benchmark-trial

usernode_pinned() {
  [ -n "${USERNODE_PINNED_BASE:-}" ]
}

# Re-assert the seal (every turn, through usernode_fetch_session_refs): the
# fetch URL, the session branch's refspec, no tags, no remote-tracking ref
# but the session branch's, origin/main at the base, and the stand-in.
usernode_reseal() {
  git config remote.origin.url "$USERNODE_SEALED_URL" || return 1
  git config --replace-all remote.origin.fetch "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" || return 1
  git config remote.origin.tagOpt --no-tags || return 1
  git for-each-ref --format='%(refname)' refs/remotes/ refs/tags/ | while read -r ref; do
    case "$ref" in
      "refs/remotes/origin/$BRANCH") ;;
      *) git update-ref --no-deref -d "$ref" ;;
    esac
  done
  git update-ref refs/remotes/origin/main "$USERNODE_PINNED_BASE" || return 1
  usernode_reseal_upstream
}

# The stand-in for the repository on GitHub (a bare repository inside the
# checkout's .git, never part of the worktree), its one ref (main at the
# base, whatever a turn pushed into it), and the rewrites: the clone URL ($1
# to usernode_clone_sealed, kept as usernode.sealedOrigin) with and without
# `.git`, also in lower case (GitHub reads owner and name either way) and over
# plain http. A rewrite matches by prefix, so another repository whose name
# merely begins with this one's would reach the stand-in too; no app has one.
# Pushing to origin goes to the clone URL through pushInsteadOf, which these
# rewrites never touch.
usernode_reseal_upstream() {
  usernode_origin=$(git config --get usernode.sealedOrigin) || return 1
  usernode_git_dir=$(git rev-parse --absolute-git-dir) || return 1
  usernode_standin="$usernode_git_dir/usernode-sealed-upstream"
  if [ ! -d "$usernode_standin" ]; then
    git init --quiet --bare "$usernode_standin" || return 1
  fi
  printf '%s/objects\n' "$usernode_git_dir" > "$usernode_standin/objects/info/alternates" || return 1
  git --git-dir="$usernode_standin" for-each-ref --format='%(refname)' | while read -r ref; do
    [ "$ref" = refs/heads/main ] || git --git-dir="$usernode_standin" update-ref --no-deref -d "$ref"
  done
  git --git-dir="$usernode_standin" update-ref refs/heads/main "$USERNODE_PINNED_BASE" || return 1
  git --git-dir="$usernode_standin" symbolic-ref HEAD refs/heads/main || return 1
  git config --unset-all remote.origin.pushurl || true
  git config --replace-all "url.$usernode_origin.pushInsteadOf" "$USERNODE_SEALED_URL" || return 1
  # Push negotiation fetches from the push URL, which the rewrites send to the
  # stand-in; it borrows every object the checkout has, so the push would
  # conclude GitHub had the trial's commits and send none of them.
  git config push.negotiate false || return 1
  git config --unset-all "url.$usernode_standin.insteadOf" || true
  usernode_bare=${usernode_origin%.git}
  usernode_lower=$(printf '%s' "$usernode_bare" | tr 'A-Z' 'a-z')
  for usernode_spelling in "$usernode_bare" "$usernode_lower"; do
    case "$usernode_spelling" in
      https://*) set -- "$usernode_spelling" "http://${usernode_spelling#https://}" ;;
      *) set -- "$usernode_spelling" ;;
    esac
    for usernode_address in "$@"; do
      for usernode_form in "$usernode_address.git" "$usernode_address"; do
        git config --get-all "url.$usernode_standin.insteadOf" | grep -qxF "$usernode_form" \
          || git config --add "url.$usernode_standin.insteadOf" "$usernode_form" || return 1
      done
    done
  done
}

# The sealed checkout, into the (empty) current directory. $1 is the clone
# URL. Fails when the session branch does not contain the pinned base: a
# trial whose branch is not where the platform cut it must not run.
usernode_clone_sealed() {
  base=${USERNODE_PINNED_BASE:-}
  case "$base" in
    ''|*[!0-9a-f]*) echo "the pinned base is not a commit id: $base"; return 1 ;;
  esac
  if [ "${#base}" -ne 40 ]; then echo "the pinned base is not a full commit id: $base"; return 1; fi
  git init --quiet . 2>&1 || return 1
  git remote add origin "$1" 2>&1 || return 1
  git fetch --quiet --no-tags origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>&1 || return 1
  if ! git merge-base --is-ancestor "$base" "refs/remotes/origin/$BRANCH" 2>/dev/null; then
    echo "the session branch $BRANCH does not contain the pinned base $base"
    return 1
  fi
  git update-ref refs/heads/main "$base" || return 1
  git checkout --quiet -b "$BRANCH" "refs/remotes/origin/$BRANCH" 2>&1 || return 1
  git config usernode.sealedOrigin "$1" || return 1
  usernode_reseal
}

# ── Every session ───────────────────────────────────────────────────────

# Point `git fetch origin` at main alone, and forget any remote-tracking ref
# that is neither main nor this session's branch. The session branch is not
# in the configured refspec because a refspec naming a branch that does not
# exist yet (a fresh session, before its first push) fails the whole fetch;
# usernode_fetch_session_refs fetches it explicitly instead. A sealed
# benchmark checkout is re-sealed instead.
usernode_limit_remote_refs() {
  git remote get-url origin >/dev/null 2>&1 || return 1
  if usernode_pinned; then
    usernode_reseal
    return
  fi
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
# for main's fetch; returns non-zero when that failed. A sealed benchmark
# checkout fetches nothing: it is re-sealed and works from what it has.
usernode_fetch_session_refs() {
  if usernode_pinned; then
    usernode_reseal 2>&1
    return
  fi
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
