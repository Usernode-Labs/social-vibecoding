#!/bin/bash
set -euo pipefail

# Pull the remote usernode + per-app databases to local dev.
#
# Usage: ./scripts/pull-remote-db.sh
#
# Syncs:
#   - the main `usernode` control-plane DB (users, apps, sessions, ...)
#   - every `app_*` database (each child app has its own)
#
# Staging clones (app_*_staging_*) are intentionally skipped — they're
# ephemeral and get recreated on next chat turn.

REMOTE_HOST="${DEPLOY_HOST:-social-vibecoding.usernodelabs.org}"
REMOTE_USER="${DEPLOY_USER:-deploy}"
# Container names match the `container_name:` fields in the compose
# files: docker-compose.yml's `usernode-db` service for prod, and
# docker-compose.dev.yml's `vibecoding-db-dev` for local. Override
# via env if you've renamed either.
REMOTE_CONTAINER="${REMOTE_DB_CONTAINER:-usernode-db}"
LOCAL_CONTAINER="${LOCAL_DB_CONTAINER:-vibecoding-db-dev}"
DB_USER="usernode"

ssh_exec() { ssh "${REMOTE_USER}@${REMOTE_HOST}" "$@"; }

echo "Listing remote databases..."
REMOTE_DBS=$(ssh_exec "docker exec ${REMOTE_CONTAINER} psql -U ${DB_USER} -d postgres -tAc \"SELECT datname FROM pg_database WHERE datname = 'usernode' OR (datname LIKE 'app_%' AND datname NOT LIKE 'app_%_staging_%')\"")
echo "  Found: $(echo "$REMOTE_DBS" | tr '\n' ' ')"

for db in $REMOTE_DBS; do
  [ -z "$db" ] && continue
  dump_file="/tmp/usernode-remote-${db}.sql"

  echo ""
  echo "[$db] dumping remote..."
  ssh_exec "docker exec ${REMOTE_CONTAINER} pg_dump -U ${DB_USER} -d ${db}" > "${dump_file}"
  echo "  $(wc -c < "${dump_file}" | tr -d ' ') bytes -> ${dump_file}"

  echo "[$db] restoring locally..."
  if [ "$db" = "usernode" ]; then
    # Control-plane DB always exists locally; just reset the public schema.
    docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d "${db}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1
  else
    # Per-app DBs may not exist yet locally. Drop and recreate to get a
    # clean slate, then restore.
    docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d postgres -c "DROP DATABASE IF EXISTS ${db};" >/dev/null
    docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d postgres -c "CREATE DATABASE ${db};" >/dev/null
  fi
  docker exec -i "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d "${db}" < "${dump_file}" >/dev/null
  echo "  restored"
done

echo ""
echo "Done. Local synced from remote for: $(echo "$REMOTE_DBS" | tr '\n' ' ')"
