#!/bin/bash
set -euo pipefail

# Push the local usernode + per-app databases to the remote production
# instance. The inverse of pull-remote-db.sh — useful when you've been
# iterating against a local copy and want to seed prod from it.
#
# Usage: ./scripts/push-remote-db.sh
#
# DESTRUCTIVE: drops and recreates every targeted database on the
# remote (`usernode` + every `app_*` non-staging). Any data on the
# remote that isn't in your local copy will be lost. Bail out with
# Ctrl-C at the confirmation prompt if that's not what you want.
#
# Pushes:
#   - the main `usernode` control-plane DB (users, apps, sessions, ...)
#   - every `app_*` database in your local instance
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

echo "Listing local databases..."
LOCAL_DBS=$(docker exec "${LOCAL_CONTAINER}" psql -U "${DB_USER}" -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname = 'usernode' OR (datname LIKE 'app_%' AND datname NOT LIKE 'app_%_staging_%')")
echo "  Found: $(echo "$LOCAL_DBS" | tr '\n' ' ')"

echo ""
echo "About to OVERWRITE these databases on ${REMOTE_USER}@${REMOTE_HOST}:"
for db in $LOCAL_DBS; do
  [ -z "$db" ] && continue
  echo "  - ${db}"
done
echo ""
read -p "Type 'yes' to continue: " confirm
if [ "$confirm" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

for db in $LOCAL_DBS; do
  [ -z "$db" ] && continue
  dump_file="/tmp/usernode-local-${db}.sql"

  echo ""
  echo "[$db] dumping local..."
  docker exec "${LOCAL_CONTAINER}" pg_dump -U "${DB_USER}" -d "${db}" > "${dump_file}"
  echo "  $(wc -c < "${dump_file}" | tr -d ' ') bytes -> ${dump_file}"

  echo "[$db] restoring on remote..."
  if [ "$db" = "usernode" ]; then
    # Control-plane DB always exists remotely; just reset the public schema.
    ssh_exec "docker exec -i ${REMOTE_CONTAINER} psql -U ${DB_USER} -d ${db} -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'" >/dev/null 2>&1
  else
    # Per-app DBs may not exist yet remotely. Drop and recreate to get
    # a clean slate, then restore.
    ssh_exec "docker exec -i ${REMOTE_CONTAINER} psql -U ${DB_USER} -d postgres -c 'DROP DATABASE IF EXISTS ${db};'" >/dev/null
    ssh_exec "docker exec -i ${REMOTE_CONTAINER} psql -U ${DB_USER} -d postgres -c 'CREATE DATABASE ${db};'" >/dev/null
  fi
  ssh_exec "docker exec -i ${REMOTE_CONTAINER} psql -U ${DB_USER} -d ${db}" < "${dump_file}" >/dev/null
  echo "  restored"
done

echo ""
echo "Done. Remote synced from local for: $(echo "$LOCAL_DBS" | tr '\n' ' ')"
