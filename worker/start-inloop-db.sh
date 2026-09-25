#!/bin/sh
# Prepare the disposable database for a build turn. Both coding backends use
# this helper so the advertised INLOOP_DATABASE_URL has the same meaning.
# Database trouble is diagnostic, never a reason to fail the coding turn.

INLOOP_PGDATA="${INLOOP_PGDATA:-/home/node/pgdata}"
if ! command -v pg_ctl >/dev/null 2>&1 || [ ! -d "$INLOOP_PGDATA" ]; then
  echo "__USERNODE_WARN__ in-loop postgres unavailable (binary or data directory missing)"
  exit 0
fi

if ! pg_ctl -D "$INLOOP_PGDATA" status >/dev/null 2>&1; then
  if ! pg_ctl -D "$INLOOP_PGDATA" -w -l /tmp/inloop-postgres.log start >/dev/null 2>&1; then
    echo "__USERNODE_WARN__ in-loop postgres failed to start"
    exit 0
  fi
fi

# A prior turn may have left its local app connected to the same server.
psql -h 127.0.0.1 -U postgres -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'inloop' AND pid <> pg_backend_pid()" \
  >/dev/null 2>&1 || true
if dropdb --if-exists -h 127.0.0.1 -U postgres inloop >/dev/null 2>&1 \
  && createdb -h 127.0.0.1 -U postgres inloop >/dev/null 2>&1; then
  echo "__USERNODE_PHASE__ inloop-db"
else
  echo "__USERNODE_WARN__ in-loop postgres inloop-db recreate failed"
fi
