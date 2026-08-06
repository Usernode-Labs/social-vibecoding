#!/usr/bin/env bash
#
# Deploy the Usernode platform on the VPS.
#
# This is THE deploy: the single copy of the logic that used to live
# inline in .github/workflows/deploy.yml's ssh step. It has exactly two
# callers, and both run it on the VPS as the `deploy` user from
# /opt/usernode:
#
#   1. The host deployer (scripts/usernode-deployer.sh, a systemd
#      service on the VPS) — the PRIMARY path. It polls github.com for
#      a new main head, rsyncs the tree into place, and invokes this
#      script. No GitHub Actions runner is involved, so a GHA outage
#      (2026-08-06) cannot stall production deploys.
#   2. The Deploy workflow (.github/workflows/deploy.yml) — the
#      FALLBACK path, and the only path that can rotate secrets: it
#      composes a fresh .env from GitHub secrets and forwards it as
#      BASE_ENV_B64.
#
# Inputs (environment variables):
#
#   DEPLOY_SHA           (required) the sha being deployed; written to
#                        .env as GIT_SHA.
#   BASE_ENV_B64         (optional) base64 of a complete .env. When set,
#                        .env is REWRITTEN from it (workflow path, which
#                        resolves GitHub secrets). When empty, the
#                        existing .env is kept and only GIT_SHA is
#                        patched (host-deployer path — the .env from the
#                        last secret-bearing deploy stays authoritative).
#   GH_PLATFORM_ENV_B64  (optional) base64 of GitHub-sourced platform
#                        variable lines, appended after the base .env.
#   NODE_FILES_CHANGED   'true' when this deploy touches the sidecar's
#                        compose definition or archive scripts.
#   CADDY_FILES_CHANGED  'true' when caddy.Dockerfile changed.
#   FORCE_ARCHIVE_REFRESH 'true' to force the archive refresh path.
#   SKIP_IF_CURRENT      '1' to exit 0 without rebuilding when
#                        DEPLOY_SHA is already deployed and healthy.
#                        Set by the workflow's push trigger and the host
#                        deployer so the two paths never double-deploy
#                        the same commit; workflow_dispatch leaves it
#                        unset so a manual re-run always redeploys.
#
# Single-flight: both callers can fire for the same push, so the whole
# script runs under an exclusive flock. The loser of the race waits,
# then sees GIT_SHA already at its target and (with SKIP_IF_CURRENT)
# exits without a second rebuild.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/usernode}"
cd "$DEPLOY_DIR"

if [ -z "${DEPLOY_SHA:-}" ]; then
  echo "::error::DEPLOY_SHA is required" >&2
  exit 1
fi

mkdir -p runtime

# ----------------------------------------------------------------------
# Single-flight lock. 30-minute wait matches the workflow's
# command_timeout — a deploy blocked longer than that is stuck, and
# failing loudly beats queueing forever.
# ----------------------------------------------------------------------
exec 9> runtime/deploy.lock
if ! flock -w 1800 9; then
  echo "::error::Another deploy has held runtime/deploy.lock for 30m; giving up" >&2
  exit 1
fi

# The sha currently deployed, read from the .env we may be about to
# overwrite. This is what the post-deploy health probe rolls back to if
# the new container never becomes healthy. Best-effort: on a green-field
# deploy there is no previous .env, PREV_SHA stays empty, and the probe
# reports the failure without attempting a rollback to nothing.
PREV_SHA=$(grep -m1 '^GIT_SHA=' .env 2>/dev/null | cut -d= -f2- || true)
echo "==> Previous GIT_SHA: ${PREV_SHA:-(none)}"
echo "==> Target   GIT_SHA: $DEPLOY_SHA"

# Already deployed? (The losing side of a workflow/deployer race lands
# here after the winner releases the lock.)
if [ "${SKIP_IF_CURRENT:-0}" = "1" ] && [ "$PREV_SHA" = "$DEPLOY_SHA" ]; then
  if docker compose exec -T usernode wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
    echo "==> $DEPLOY_SHA is already deployed and healthy; nothing to do."
    exit 0
  fi
  echo "==> $DEPLOY_SHA is recorded in .env but the platform is unhealthy; redeploying."
fi

# Deploy-in-progress flag for the /status page. The trap clears it on
# every exit path (success, health-gate failure, ctrl-C), the same
# guarantee the workflow's `if: always()` step used to provide.
cat > runtime/deploy-status.json <<EOF
{"deploying":true,"sha":"$DEPLOY_SHA","startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
trap 'echo "{\"deploying\":false}" > runtime/deploy-status.json' EXIT

# ----------------------------------------------------------------------
# .env: rewrite (workflow path) or patch (host-deployer path).
#
# The workflow composes the base .env from GitHub secrets on the runner
# and forwards it as one base64 blob — when present it is authoritative
# and .env is rewritten from scratch. The host deployer has no access to
# GitHub secrets and doesn't need any: the on-disk .env from the last
# secret-bearing deploy is still correct, so it only patches GIT_SHA.
# Green-field installs must come through the workflow (or write .env by
# hand) — patch mode refuses to invent a configuration.
# ----------------------------------------------------------------------
if [ -n "${BASE_ENV_B64:-}" ]; then
  echo "$BASE_ENV_B64" | base64 -d > .env
  chmod 600 .env
  # GitHub-sourced values for manifest-declared platform variables.
  # Appended AFTER the base so they override a committed default for the
  # same key — docker compose's env-file parser takes the last
  # occurrence. The admin-console values are appended after these and
  # win over both.
  if [ -n "${GH_PLATFORM_ENV_B64:-}" ]; then
    echo "$GH_PLATFORM_ENV_B64" | base64 -d >> .env
    echo "==> Applied $(echo "$GH_PLATFORM_ENV_B64" | base64 -d | grep -c . || true) GitHub-sourced platform variable(s)"
  fi
else
  if [ ! -f .env ]; then
    echo "::error::No BASE_ENV_B64 and no existing .env — a first deploy must run through the Deploy workflow (or write /opt/usernode/.env by hand) so the platform has its secrets" >&2
    exit 1
  fi
  echo "==> No BASE_ENV_B64: keeping the existing .env, patching GIT_SHA only."
  awk -v sha="$DEPLOY_SHA" 'BEGIN{FS=OFS="="} /^GIT_SHA=/ {$2=sha; seen=1} {print} END{if (!seen) print "GIT_SHA=" sha}' \
    .env > .env.deploy.tmp
  mv .env.deploy.tmp .env
  chmod 600 .env
fi

# ----------------------------------------------------------------------
# Pull non-buildable images first so we can detect upstream node image
# bumps. `--ignore-buildable` skips services with a build context (the
# platform `usernode` image), so this only pulls caddy / postgres /
# usernode-node. The platform image is rebuilt below.
#
# We capture usernodelabs/usernode's image ID before+after so the gating
# block below can treat an upstream bump as equivalent to a
# node-affecting change — a new sidecar binary may have new
# archive-format expectations or bug fixes we want paired with a
# known-good archive.
# ----------------------------------------------------------------------
BEFORE_NODE_IMG=$(docker image inspect usernodelabs/usernode:latest --format '{{.Id}}' 2>/dev/null || echo "none")
docker compose pull --ignore-buildable
AFTER_NODE_IMG=$(docker image inspect usernodelabs/usernode:latest --format '{{.Id}}' 2>/dev/null || echo "none")

# ----------------------------------------------------------------------
# Decide whether to refresh the sidecar's archive snapshot and
# force-recreate the usernode-node container. Refresh is triggered when
# ANY of:
#   1. NODE_FILES_CHANGED=true: this deploy modifies the sidecar's
#      compose definition or the archive-fetch scripts (paths-filter in
#      the workflow; git diff in the host deployer).
#   2. FORCE_ARCHIVE_REFRESH=true: operator override.
#   3. The pulled usernodelabs/usernode:latest digest differs from what
#      was on disk before the pull.
#
# Otherwise (the common path: pure platform-code change), we leave the
# running sidecar alone. Its --archive flag self-maintains the on-disk
# snapshot at the configured interval, so the existing volume stays
# valid across arbitrarily many code-only deploys. Skipping the refresh
# avoids dropping every child-app's SSE stream on every push and saves
# ~1 min of cold-boot.
# ----------------------------------------------------------------------
SHOULD_REFRESH_NODE=0
if [ "${NODE_FILES_CHANGED:-false}" = "true" ]; then
  SHOULD_REFRESH_NODE=1
  echo "==> Node-related files changed in this deploy; will refresh archive."
fi
if [ "${FORCE_ARCHIVE_REFRESH:-false}" = "true" ]; then
  SHOULD_REFRESH_NODE=1
  echo "==> Archive refresh forced by the caller."
fi
if [ "$BEFORE_NODE_IMG" != "$AFTER_NODE_IMG" ]; then
  SHOULD_REFRESH_NODE=1
  echo "==> Upstream usernodelabs/usernode image changed:"
  echo "      before: $BEFORE_NODE_IMG"
  echo "      after:  $AFTER_NODE_IMG"
  echo "    Will refresh archive."
fi

if [ "$SHOULD_REFRESH_NODE" = "1" ]; then
  # --------------------------------------------------------------------
  # Archive snapshot: fetch from testnet-seed1 directly from prod
  # (reuses prod's existing seed SSH access — no runner-side key
  # needed). Why: PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG — the sidecar's
  # runtime `tracked_owner/add` calls (every child app fires one at
  # boot) trip the wallet-seed shortcut into partial-ledger overlay by
  # default. Booting from a full archive snapshot fixes it: node loads
  # the full tree at startup and applies every subsequent block in full
  # mode, so RecentTxEntry.source is authoritative and dapps actually
  # see incoming txs on the SSE stream.
  #
  # Prereq on this VPS: ~deploy/.ssh/config must define `testnet-seed1`
  # and the deploy user must have an authorized_keys entry on that seed.
  # Verify with:
  #   ssh -o BatchMode=yes -o ConnectTimeout=5 testnet-seed1 echo ok
  # --------------------------------------------------------------------
  STAGING_DIR="/tmp/usernode-archive-staging-$$"
  ARCHIVE_VOLUME="usernode_usernode-node-archive"
  FETCH_OK=0

  echo "==> Fetching fresh archive snapshot from testnet-seed1..."
  mkdir -p "$STAGING_DIR"
  if ./scripts/fetch-archive-snapshot.sh testnet-seed1 "$STAGING_DIR" --replace; then
    FETCH_OK=1
    echo "==> Staged archive size:"
    du -sh "$STAGING_DIR"
  else
    echo "==> WARNING: archive fetch from testnet-seed1 failed."
  fi

  if [ "$FETCH_OK" = "1" ]; then
    echo "==> Streaming staged snapshot into docker volume $ARCHIVE_VOLUME..."
    # One-shot alpine container that wipes the existing volume contents
    # and unpacks the fresh snapshot in place. Volume is created lazily
    # by docker run if it doesn't exist yet.
    tar -czf - -C "$STAGING_DIR" . | docker run --rm -i \
      -v "$ARCHIVE_VOLUME:/archive" alpine \
      sh -c 'rm -rf /archive/* /archive/.[!.]* /archive/..?* 2>/dev/null; tar -xzf - -C /archive && echo "==> Volume populated: $(du -sh /archive | cut -f1)"'
    rm -rf "$STAGING_DIR"
    # Fresh snapshot landed in the volume — but compose only recreates
    # containers when their *definition* changes, not when their
    # *volume contents* change. Force a recreate so the sidecar reboots
    # from the fresh snapshot. `--no-deps` keeps the recreate scoped to
    # this one service.
    echo "==> Recreating usernode-node so it picks up the fresh archive..."
    docker compose up -d --no-deps --force-recreate usernode-node

    # Child-app cache flush. Every dapp server keeps an in-memory raw-tx
    # cache (createAppStateCache) that dedups by tx_id. If the sidecar
    # was running in partial-ledger mode for any window before this
    # recreate, those caches hold rows with source=null, and the new
    # full-mode SSE stream's re-deliveries (same tx_ids, source set) get
    # dropped by the dedup. Restart them all so they re-backfill from
    # the now-authoritative sidecar.
    echo "==> Restarting child-app containers to flush stale source-null cache rows..."
    docker ps --format '{{.Names}}' | grep '^usernode-app-' \
      | xargs -r -n 1 -P 8 docker restart \
      | sed 's/^/    restarted: /'
  else
    # Fetch failed. The sidecar's --archive flag self-writes new
    # snapshots over time, so a non-empty existing volume is fine to
    # reuse. But an EMPTY volume means the sidecar boots without an
    # archive → wallet-seed shortcut → partial-ledger mode → silent dapp
    # breakage. Fail loudly instead.
    echo "==> Probing existing archive volume..."
    ARCHIVE_SIZE=$(docker run --rm -v "$ARCHIVE_VOLUME:/archive" alpine du -sb /archive 2>/dev/null | cut -f1 || echo 0)
    echo "==> Existing archive size: ${ARCHIVE_SIZE:-0} bytes"
    # A live archive (chain_id + checkpoint binprots + blocks dir) is
    # tens to hundreds of MB. Anything under 1 MB is effectively empty.
    if [ "${ARCHIVE_SIZE:-0}" -lt 1000000 ]; then
      echo "::error::Archive fetch from testnet-seed1 FAILED and prod has no usable existing archive (${ARCHIVE_SIZE:-0} bytes). Refusing to deploy a partial-ledger sidecar — that would silently break every dapp via PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG. Fix prod's SSH access to testnet-seed1 (~deploy/.ssh/config) or pre-seed the volume manually, then re-run."
      rm -rf "$STAGING_DIR"
      exit 1
    fi
    echo "::warning::Archive fetch failed but prod has an existing archive (${ARCHIVE_SIZE} bytes from a previous deploy or self-write). Continuing with that snapshot — sidecar will boot in full mode."
  fi
else
  echo "==> No node-affecting changes (compose / scripts / upstream image / override); skipping archive refresh."
  echo "==> Sidecar keeps running with its existing self-maintained archive."
fi

# ----------------------------------------------------------------------
# Mirror the out-of-band tools into /opt/usernode-tools/ so they sit at
# a stable path that survives rsync --delete (which scopes to
# /opt/usernode/ only):
#
#   - rollback.sh must work even when the harness is on fire (see
#     SELF-HOSTING.md Phase 1).
#   - usernode-deployer.sh is the running copy the systemd service
#     executes; installing the fresh one here is how the deployer
#     self-updates (it re-execs itself after each successful deploy).
#     install(1) unlinks the destination first, so overwriting the
#     script the calling deployer is mid-way through executing is safe —
#     the running process keeps its old inode.
#   - the systemd unit is refreshed (daemon-reload only; never a restart
#     from in here — the deployer may be our own parent). Unit-file
#     changes take effect on the next manual `systemctl restart`.
#
# `install -d` is idempotent and uses sudo only for the dir (deploy has
# passwordless sudo per scripts/server-bootstrap.sh).
# ----------------------------------------------------------------------
sudo install -d -o deploy -g deploy -m 755 /opt/usernode-tools
install -m 755 scripts/rollback.sh /opt/usernode-tools/rollback.sh
install -m 755 scripts/usernode-deployer.sh /opt/usernode-tools/usernode-deployer.sh
if ! sudo cmp -s scripts/usernode-deployer.service /etc/systemd/system/usernode-deployer.service 2>/dev/null; then
  sudo install -m 644 scripts/usernode-deployer.service /etc/systemd/system/usernode-deployer.service
  sudo systemctl daemon-reload || true
  echo "==> usernode-deployer.service updated (takes effect on its next restart)."
fi

# ----------------------------------------------------------------------
# One-time platform DB rename (SELF-HOSTING.md sub-step 2d). The
# platform's own data moves from the bare `usernode` database to
# `app_usernode_2d5619`, matching the `app_<slug>` convention every
# child app follows.
#
# Idempotent: if the target DB already exists AND looks healthy, this is
# a 1-line no-op. The bare `usernode` DB stays in place permanently as
# the postgres-bookkeeping target db-manager.js issues `CREATE DATABASE`
# from when spawning child-app DBs.
# ----------------------------------------------------------------------
SRC_DB="usernode"
NEW_DB="app_usernode_2d5619"
DB_CHECK_TABLES=(users apps chat_messages)
DB_NONEMPTY_TABLE="users"

if docker exec usernode-db psql -U usernode -lqt 2>/dev/null \
     | cut -d'|' -f1 | tr -d ' ' | grep -qx "$NEW_DB"; then
  echo "==> $NEW_DB already exists; sanity-checking"
  MIGRATED_OK=1
  for tbl in "${DB_CHECK_TABLES[@]}"; do
    TGT=$(docker exec usernode-db psql -U usernode -d "$NEW_DB" -tAc "SELECT count(*) FROM $tbl" 2>/dev/null || echo "missing")
    if [ "$TGT" = "missing" ]; then
      echo "::error::table $tbl is missing in $NEW_DB"
      MIGRATED_OK=0
      break
    fi
    if [ "$tbl" = "$DB_NONEMPTY_TABLE" ] && [ "$TGT" -lt 1 ] 2>/dev/null; then
      echo "::error::$tbl in $NEW_DB is empty (count=$TGT)"
      MIGRATED_OK=0
      break
    fi
  done
  if [ "$MIGRATED_OK" -ne 1 ]; then
    echo "::error::$NEW_DB exists but appears unhealthy. Refusing to proceed."
    echo "::error::Manual intervention required: drop $NEW_DB and re-run, or investigate."
    exit 1
  fi
  echo "==> $NEW_DB looks healthy; skipping migration"
else
  echo "==> One-time migration: $SRC_DB -> $NEW_DB"
  if ! docker exec usernode-db psql -U usernode -lqt 2>/dev/null \
       | cut -d'|' -f1 | tr -d ' ' | grep -qx "$SRC_DB"; then
    echo "==> Source DB $SRC_DB does not exist either. Treating as fresh install:"
    echo "==> creating empty $NEW_DB so schema.sql can populate it on first boot."
    docker exec -u postgres usernode-db createdb \
      -U usernode -O usernode "$NEW_DB"
  else
    # Stop the harness so no concurrent writes can land in SRC_DB
    # between the dump and the cutover.
    docker compose stop usernode

    TS=$(date -u +%Y%m%dT%H%M%SZ)
    DUMP_PATH="/tmp/usernode-pre-rename-$TS.sql"
    echo "==> Dumping $SRC_DB to $DUMP_PATH"
    if ! docker exec -i usernode-db pg_dump -U usernode "$SRC_DB" > "$DUMP_PATH"; then
      echo "::error::pg_dump failed; aborting before any DB-state changes"
      exit 1
    fi
    echo "==> Dump size: $(du -h "$DUMP_PATH" | cut -f1)"

    echo "==> Creating $NEW_DB"
    if ! docker exec -u postgres usernode-db createdb \
           -U usernode -O usernode "$NEW_DB"; then
      echo "::error::createdb failed; $NEW_DB may exist in a partial state"
      exit 1
    fi

    echo "==> Restoring dump into $NEW_DB"
    if ! docker exec -i usernode-db psql -U usernode -d "$NEW_DB" -v ON_ERROR_STOP=1 < "$DUMP_PATH"; then
      echo "::error::Restore failed; dropping $NEW_DB so next attempt starts clean"
      docker exec -u postgres usernode-db dropdb -U usernode "$NEW_DB" || true
      exit 1
    fi

    echo "==> Verifying row counts match"
    MISMATCH=0
    for tbl in "${DB_CHECK_TABLES[@]}"; do
      SRC=$(docker exec usernode-db psql -U usernode -d "$SRC_DB" -tAc "SELECT count(*) FROM $tbl")
      TGT=$(docker exec usernode-db psql -U usernode -d "$NEW_DB" -tAc "SELECT count(*) FROM $tbl")
      echo "    $tbl: $SRC_DB=$SRC, $NEW_DB=$TGT"
      if [ "$SRC" != "$TGT" ]; then
        MISMATCH=1
      fi
    done
    if [ "$MISMATCH" -eq 1 ]; then
      echo "::error::Row counts do not match. Dropping $NEW_DB; aborting."
      docker exec -u postgres usernode-db dropdb -U usernode "$NEW_DB" || true
      exit 1
    fi
    echo "==> Migration complete; counts match"
  fi
fi

# ----------------------------------------------------------------------
# Build first, separately from `up`, so the freshly-built image can
# resolve the admin-console platform variables into .env BEFORE the
# platform container starts with it. caddy is deliberately NOT rebuilt
# on routine deploys (#711) — xcaddy builds are not reproducible, so an
# unscoped `up -d --build` could recreate caddy (a full edge outage) on
# a deploy that didn't touch it.
# ----------------------------------------------------------------------
docker compose build usernode

# ----------------------------------------------------------------------
# Materialize the platform variables an admin set in the console. They
# live encrypted in the platform's own database, so something with the
# DB credentials has to decrypt them — and /opt/usernode/runtime is
# mounted :ro, so the running platform cannot write the snapshot itself.
# A throwaway container off the image we just built has the credentials
# already via env_file. --no-deps because usernode-db is already up; -T
# so stdout and stderr stay separate streams.
#
# Failure is non-fatal by design: `|| true` plus the sentinel check
# means a DB hiccup reuses the previous run's cached .platform-env
# rather than failing the deploy or silently truncating the platform's
# configuration.
# ----------------------------------------------------------------------
RAW_ENV=$(docker compose run --rm --no-deps -T usernode \
  node scripts/dump-platform-env.js 2>/dev/null || true)
if echo "$RAW_ENV" | grep -q '^#__PLATFORM_ENV_END__$'; then
  # `|| true`: a complete-but-empty block (no console-set variables yet)
  # makes grep -v exit 1, which under set -e would kill the deploy.
  echo "$RAW_ENV" \
    | sed -n '/^#__PLATFORM_ENV_BEGIN__$/,/^#__PLATFORM_ENV_END__$/p' \
    | { grep -v '^#__PLATFORM_ENV_' || true; } > .platform-env.new
  mv .platform-env.new .platform-env
  chmod 600 .platform-env
  echo "==> Resolved $(grep -c . .platform-env || true) console-set platform variable(s)"
else
  echo "==> WARNING: platform-env resolution produced no complete block; reusing cache"
fi
if [ -s .platform-env ]; then
  # In patch mode the .env still carries the console block a previous
  # deploy appended; strip it before re-appending so the file doesn't
  # grow one duplicate block per deploy. (Compose takes the last
  # occurrence, so pre-marker legacy appends are harmless — they get
  # overridden by the fresh block below and disappear entirely on the
  # next workflow-path deploy.)
  awk '/^#__CONSOLE_ENV_BEGIN__$/{skip=1} !skip{print} /^#__CONSOLE_ENV_END__$/{skip=0}' \
    .env > .env.deploy.tmp
  mv .env.deploy.tmp .env
  chmod 600 .env
  echo '#__CONSOLE_ENV_BEGIN__' >> .env
  cat .platform-env >> .env
  echo '#__CONSOLE_ENV_END__' >> .env
fi

# ----------------------------------------------------------------------
# Don't cut over while a pg_dump of the platform database is in flight.
# Every staging-preview build of the self-app dumps $NEW_DB from
# *inside* the usernode-db container, so the dump survives the platform
# container being recreated — and its ACCESS SHARE locks on every table
# block the new container's boot migrations (ALTER TABLE needs ACCESS
# EXCLUSIVE), eating the whole 120s health gate and triggering a
# spurious rollback (2026-07-30 incident, run 30578204174).
#
# 10-minute cap: a dump of the ~10 GB platform DB finishes in
# single-digit minutes. If one is somehow stuck we proceed anyway —
# migrate.js's lock_timeout+retry loop and the health gate below are the
# second line of defense.
# ----------------------------------------------------------------------
DUMP_WAITED=0
while [ "$DUMP_WAITED" -lt 600 ]; do
  ACTIVE_DUMPS=$(docker exec usernode-db psql -U usernode -d postgres -Atc \
    "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pg_dump' AND datname = '$NEW_DB'" \
    2>/dev/null || echo 0)
  if [ "${ACTIVE_DUMPS:-0}" = "0" ]; then break; fi
  if [ "$DUMP_WAITED" -eq 0 ]; then
    echo "==> Waiting for $ACTIVE_DUMPS in-flight pg_dump(s) of $NEW_DB (staging clone) to finish before cutover..."
  fi
  sleep 10
  DUMP_WAITED=$((DUMP_WAITED + 10))
done
if [ "$DUMP_WAITED" -ge 600 ]; then
  echo "==> WARNING: platform-DB pg_dump still running after ${DUMP_WAITED}s; proceeding anyway."
elif [ "$DUMP_WAITED" -gt 0 ]; then
  echo "==> Platform-DB dump(s) finished after ${DUMP_WAITED}s; cutting over."
fi

docker compose up -d usernode
docker compose up -d --remove-orphans

# ----------------------------------------------------------------------
# Post-deploy health gate. A platform variable that is declared, unset,
# and read at boot is exactly the failure the pre-merge check tries to
# prevent — but the check can be skipped (force-merge, a value cleared
# after the merge, a GitHub outage that made it fail open), so the
# deploy needs its own answer to "did it actually come up?".
#
# Two CONSECUTIVE successes: a container mid-boot can answer once and
# then exit, and a single 200 from a process that is about to crash is
# worse than no signal at all.
# ----------------------------------------------------------------------
HEALTH_OK=0
HEALTH_STREAK=0
HEALTH_WAITED=0
while [ "$HEALTH_WAITED" -lt 120 ]; do
  if docker compose exec -T usernode wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
    HEALTH_STREAK=$((HEALTH_STREAK + 1))
    if [ "$HEALTH_STREAK" -ge 2 ]; then HEALTH_OK=1; break; fi
  else
    HEALTH_STREAK=0
  fi
  sleep 5
  HEALTH_WAITED=$((HEALTH_WAITED + 5))
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo "::error::Platform did not become healthy within 120s of deploying ${DEPLOY_SHA:-(unknown sha)}"
  echo "==> Last 200 log lines from the unhealthy container:"
  docker compose logs --tail 200 usernode || true
  if [ -n "$PREV_SHA" ] && [ -x /opt/usernode-tools/rollback.sh ]; then
    echo "==> Rolling back to $PREV_SHA"
    /opt/usernode-tools/rollback.sh "$PREV_SHA" || \
      echo "::error::Rollback to $PREV_SHA also failed — manual intervention required"
  else
    echo "::error::No previous sha or rollback script available; leaving the stack as-is"
  fi
  exit 1
fi
echo "==> Platform healthy after ${HEALTH_WAITED}s"

if [ "${CADDY_FILES_CHANGED:-false}" = "true" ]; then
  echo "==> caddy.Dockerfile changed; rebuilding + recreating caddy"
  docker compose build caddy
  docker compose up -d caddy
fi

# Caddyfile is a read-only mount, so a rebuild of usernode alone won't
# restart caddy. Force a config reload so any Caddyfile changes from
# this deploy take effect. `|| true` because on the very first deploy
# caddy may not be fully up yet (it's racing with TLS issuance).
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile || true

echo "==> Deploy of $DEPLOY_SHA complete."
