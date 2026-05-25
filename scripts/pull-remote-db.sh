#!/bin/bash
set -euo pipefail

# Pull the remote usernode + per-app databases to local dev.
#
# Usage: ./scripts/pull-remote-db.sh
#
# Syncs:
#   - every `app_*` database (each child app has its own)
#   - the platform's self-hosted DB (prod runs the platform as a child
#     app, so its real data lives in `app_<selfAppSlug>` rather than the
#     legacy `usernode` DB). That DB's contents are also mirrored into
#     the local `usernode` DB so the dev server (which connects to
#     `usernode` per docker-compose.dev.yml) sees prod's real data.
#   - the legacy `usernode` DB only as a fallback if prod is not self-
#     hosting (older deployments). On a self-hosting prod its `usernode`
#     DB is frozen pre-multitenancy junk, so we skip it.
#
# Staging clones (app_*_staging_*) are intentionally skipped — they're
# ephemeral and get recreated on next chat turn.

REMOTE_HOST="${DEPLOY_HOST:-social-vibecoding.usernodelabs.org}"
REMOTE_USER="${DEPLOY_USER:-deploy}"
PUBLIC_URL="${PUBLIC_URL:-https://${REMOTE_HOST}}"
# Container names match the `container_name:` fields in the compose
# files: docker-compose.yml's `usernode-db` service for prod, and
# docker-compose.dev.yml's `vibecoding-db-dev` for local. Override
# via env if you've renamed either.
REMOTE_CONTAINER="${REMOTE_DB_CONTAINER:-usernode-db}"
LOCAL_CONTAINER="${LOCAL_DB_CONTAINER:-vibecoding-db-dev}"
LOCAL_PLATFORM_DB="${LOCAL_PLATFORM_DB:-usernode}"
DB_USER="usernode"

ssh_exec() { ssh "${REMOTE_USER}@${REMOTE_HOST}" "$@"; }

restore_into_existing_db() {
  local target=$1 dump=$2
  docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d "${target}" \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1
  docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d "${target}" \
    < "${dump}" >/dev/null
}

restore_into_fresh_db() {
  local target=$1 dump=$2
  docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d postgres \
    -c "DROP DATABASE IF EXISTS ${target};" >/dev/null
  docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d postgres \
    -c "CREATE DATABASE ${target};" >/dev/null
  docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d "${target}" \
    < "${dump}" >/dev/null
}

# Detect prod's self-app DB via /api/version. selfAppSlug is set when
# the platform is self-hosting; we map slug -> app_<slug-with-_> just
# like server.js does.
self_slug=""
if command -v curl >/dev/null 2>&1; then
  self_slug=$(curl -fsS --max-time 10 "${PUBLIC_URL}/api/version" 2>/dev/null \
    | sed -nE 's/.*"selfAppSlug":"([^"]+)".*/\1/p' || true)
fi
if [ -n "$self_slug" ]; then
  self_db="app_$(echo "$self_slug" | tr '-' '_')"
  echo "Self-hosted platform detected: slug=${self_slug} db=${self_db}"
  echo "  -> will mirror it into local '${LOCAL_PLATFORM_DB}'"
else
  self_db=""
  echo "No selfAppSlug at ${PUBLIC_URL}/api/version; treating prod 'usernode' as platform DB"
fi

echo ""
echo "Listing remote databases..."
REMOTE_DBS=$(ssh_exec "docker exec ${REMOTE_CONTAINER} psql -U ${DB_USER} -d postgres -tAc \"SELECT datname FROM pg_database WHERE datname = 'usernode' OR (datname LIKE 'app_%' AND datname NOT LIKE 'app_%_staging_%')\"")
echo "  Found: $(echo "$REMOTE_DBS" | tr '\n' ' ')"

for db in $REMOTE_DBS; do
  [ -z "$db" ] && continue

  # Skip prod's legacy 'usernode' DB when self-hosted: it's frozen
  # pre-multitenancy junk, and we mirror $self_db into local 'usernode'
  # below instead.
  if [ -n "$self_db" ] && [ "$db" = "usernode" ]; then
    echo ""
    echo "[$db] skipping (stale legacy DB; ${self_db} is the live platform DB)"
    continue
  fi

  dump_file="/tmp/usernode-remote-${db}.sql"

  echo ""
  echo "[$db] dumping remote..."
  ssh_exec "docker exec ${REMOTE_CONTAINER} pg_dump -U ${DB_USER} -d ${db}" > "${dump_file}"
  echo "  $(wc -c < "${dump_file}" | tr -d ' ') bytes -> ${dump_file}"

  echo "[$db] restoring locally..."
  if [ "$db" = "$LOCAL_PLATFORM_DB" ]; then
    # Legacy fallback: prod is not self-hosted, so its 'usernode' DB
    # IS the platform DB. Restore directly into local 'usernode'.
    restore_into_existing_db "$LOCAL_PLATFORM_DB" "$dump_file"
    echo "  restored into local '${LOCAL_PLATFORM_DB}'"
  else
    restore_into_fresh_db "$db" "$dump_file"
    echo "  restored as ${db}"
  fi

  # Self-app DB also gets mirrored into local platform DB so the dev
  # server (which connects to $LOCAL_PLATFORM_DB, see docker-compose.dev.yml)
  # actually sees prod's data.
  if [ -n "$self_db" ] && [ "$db" = "$self_db" ]; then
    echo "[$db] mirroring into local '${LOCAL_PLATFORM_DB}' (dev platform DB)..."
    restore_into_existing_db "$LOCAL_PLATFORM_DB" "$dump_file"
    echo "  mirrored into local '${LOCAL_PLATFORM_DB}'"
  fi
done

echo ""
echo "Done. Local synced from remote."
if [ -n "$self_db" ]; then
  echo "Dev server (DB '${LOCAL_PLATFORM_DB}') is now mirroring prod '${self_db}'."
fi
