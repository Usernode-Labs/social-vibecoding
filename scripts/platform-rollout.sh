#!/usr/bin/env bash
#
# Zero-downtime (blue-green) rollout of the Usernode platform container.
#
# The platform runs as two interchangeable colors — usernode-blue and
# usernode-green (see the x-usernode-platform anchor in docker-compose.yml).
# Exactly one color serves the apex + access-gate vhosts at a time; the other
# is idle. A deploy:
#
#   1. builds the new image (shared tag usernode-platform:latest),
#   2. starts the IDLE color from it and waits for it to pass /health,
#   3. flips Caddy's active-color import file to the new color and reloads
#      Caddy gracefully (in-flight conns drain; new conns hit the new color),
#   4. drains and stops the OLD color.
#
# HTTP request handling is stateless against the shared Postgres, so both
# colors can serve simultaneously during the brief cutover overlap. The
# singleton background work (worker adoption, headless resume, recovery,
# sweepers, the main-drift poller) is gated behind a Postgres advisory lock
# (src/services/leadership.js): the OLD color stays leader until it stops and
# releases the lock, then the NEW color promotes itself. That ordering is why
# we flip traffic BEFORE stopping the old color, and stop the old color only
# after the new one is healthy.
#
# Invoked by scripts/deploy.sh (both the host deployer and the GHA
# fallback converge there) after the .env write + infra `compose up`.
# Safe to re-run: it always targets whichever color is NOT currently
# live, so a retried/failed rollout converges.
#
# Caddy's active-color file is the source of truth for "which color is live":
# caddy/active/platform-upstream.caddy. A copy is committed pointing at blue
# for local use, but on the deploy host the file is HOST-MANAGED state:
# excluded from every deploy rsync (like .env), seeded via
# `--ensure-active-file` on a fresh host, and rewritten here on every flip.

set -euo pipefail

# Run from the repo root (== /opt/usernode in prod) so the relative compose
# file + active-color path resolve regardless of caller cwd.
cd "$(dirname "$0")/.."

ACTIVE_FILE="caddy/active/platform-upstream.caddy"
# How long to wait for the freshly-started color to report healthy before
# giving up (and leaving the live color untouched). Overridable for slow
# boxes / cold first builds.
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-150}"
# Grace period handed to `docker compose stop` for the old color so its
# SIGTERM handler (cleanup() in server.js) can drain HTTP handlers and
# release the leader lock before the container is killed.
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-40}"

log() { echo "==> $*"; }

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

# Which color does Caddy currently route the apex/gate to? Defaults to blue
# when the file is missing/unrecognized (matches the committed bootstrap).
live_color() {
  if grep -q 'usernode-green:3000' "$ACTIVE_FILE" 2>/dev/null; then
    echo green
  else
    echo blue
  fi
}

# Rewrite the active-color import file. Kept byte-for-byte consistent with the
# committed bootstrap copy (caddy/active/platform-upstream.caddy) except for
# the color, so a `git diff` after a deploy shows only the color line(s).
write_active() {
  local color="$1"
  # The directory is host-managed state excluded from deploy rsyncs, so
  # it may not exist yet on a fresh host.
  mkdir -p "$(dirname "$ACTIVE_FILE")"
  cat > "$ACTIVE_FILE" <<EOF
# Active blue/green platform color for the apex + access-gate upstreams.
#
# MANAGED FILE — rewritten by scripts/platform-rollout.sh on every
# zero-downtime deploy, then picked up via a graceful \`caddy reload\`. The
# committed value (blue) is only the bootstrap default for a cold start /
# local use; in production the rollout always writes the color it just cut
# over to before reloading Caddy. Keep the content here byte-identical to
# write_active() in scripts/platform-rollout.sh (modulo the color).
#
# Why these two upstreams flip here (and not via the shared \`usernode\`
# network alias that the wildcard \`default\` row + the error-handler
# fallback + PLATFORM_INTERNAL_URL use): the apex site and the per-app
# access gate carry turn-scoped SSE / WebSocket streams, so they need an
# all-or-nothing cutover to one color rather than DNS round-robin across
# both during the rollout overlap.
#
# Both snippets keep the #711 hold-and-retry: a color that crash-restarts
# outside a rollout (or a cold start) reads as a brief latency bump, not
# a 502 storm. Sizing rationale lives in the Caddyfile comments.
(platform_upstream) {
	reverse_proxy usernode-${color}:3000 {
		lb_try_duration 30s
		lb_try_interval 250ms
		transport http {
			dial_timeout 2s
		}
	}
}

(platform_gate) {
	forward_auth usernode-${color}:3000 {
		uri /__caddy/access
		lb_try_duration 30s
		lb_try_interval 250ms
		transport http {
			dial_timeout 2s
		}
	}
}
EOF
}

# Poll the container's own /health (wget is in the platform image; the compose
# healthcheck uses it too) until it answers 200 twice IN A ROW or we time out.
# Two consecutive successes because a container mid-boot can answer once and
# then exit — flipping traffic on a single 200 from a process about to crash
# is worse than waiting 2 more seconds.
wait_healthy() {
  local name="$1"
  local streak=0
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if docker exec "$name" wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
      streak=$((streak + 1))
      if [ "$streak" -ge 2 ]; then return 0; fi
    else
      streak=0
    fi
    sleep 2
  done
  return 1
}

# Graceful Caddy config reload (re-reads the Caddyfile, which `import`s the
# active-color file we just rewrote). Retried because on a very first deploy
# Caddy may still be coming up / racing TLS issuance.
reload_caddy() {
  local i
  for i in 1 2 3 4 5; do
    if docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
      return 0
    fi
    log "Caddy reload attempt $i failed; retrying in 3s"
    sleep 3
  done
  return 1
}

# One-time migration off the pre-blue-green single `usernode` container. It
# runs the OLD image (no leader lock) and shared the `usernode` service name,
# so leaving it running would double-run the singleton sweepers against the
# new color. Remove it before starting a color. No-op on every later deploy.
remove_legacy_container() {
  if docker inspect usernode >/dev/null 2>&1; then
    log "Removing legacy pre-blue-green 'usernode' container (one-time)"
    docker rm -f usernode >/dev/null 2>&1 || true
  fi
}

# Seed-only mode, called by deploy.sh before the caddy container comes
# up: materialize the bootstrap active file (blue) on a host that has
# never rolled out — the file is excluded from deploy rsyncs (it's
# host-managed state, like .env), so a green-field install has nothing
# at the Caddyfile's import path until this runs. Never overwrites: once
# a rollout has written the file, it is the source of truth for which
# color is live.
if [ "${1:-}" = "--ensure-active-file" ]; then
  if [ ! -f "$ACTIVE_FILE" ]; then
    log "Seeding bootstrap active-color file (blue) at $ACTIVE_FILE"
    write_active blue
  fi
  exit 0
fi

LIVE="$(live_color)"
if [ "$LIVE" = "blue" ]; then IDLE=green; else IDLE=blue; fi

log "Building platform image (shared tag usernode-platform:latest)"
docker compose build "usernode-$IDLE"

remove_legacy_container

# If the live color isn't actually running (cold start, crash, or first
# blue-green deploy after the legacy container was just removed), there's
# nothing to cut over FROM. Just bring the live-per-file color up directly,
# make sure the active file names it, and reload Caddy. No overlap needed.
if ! container_running "usernode-$LIVE"; then
  log "No running live color — cold-starting usernode-$LIVE directly"
  docker compose up -d --no-deps --force-recreate "usernode-$LIVE"
  if ! wait_healthy "usernode-$LIVE"; then
    echo "::error::usernode-$LIVE failed to become healthy within ${HEALTH_TIMEOUT}s" >&2
    docker compose logs --tail 50 "usernode-$LIVE" >&2 || true
    exit 1
  fi
  write_active "$LIVE"
  reload_caddy || { echo "::error::Caddy reload failed after cold start" >&2; exit 1; }
  log "Cold start complete — live on usernode-$LIVE"
  exit 0
fi

# ── Steady-state blue-green cutover ──────────────────────────────────────
log "Live color: usernode-$LIVE | deploying into idle color: usernode-$IDLE"

# Start the idle color fresh from the new image. --no-deps so we don't bounce
# db/node/caddy; --force-recreate so a leftover stopped idle container from a
# previous rollout is replaced with the new image + env.
log "Starting idle color usernode-$IDLE"
docker compose up -d --no-deps --force-recreate "usernode-$IDLE"

log "Waiting for usernode-$IDLE to pass /health (timeout ${HEALTH_TIMEOUT}s)"
if ! wait_healthy "usernode-$IDLE"; then
  echo "::error::usernode-$IDLE failed health check — leaving usernode-$LIVE live, aborting rollout" >&2
  docker compose logs --tail 50 "usernode-$IDLE" >&2 || true
  # Stop the failed idle color so a retry starts clean and we don't leave two
  # colors running (the failed one is a follower, harmless, but tidy up).
  docker compose stop "usernode-$IDLE" >/dev/null 2>&1 || true
  exit 1
fi

log "usernode-$IDLE healthy — flipping Caddy apex + gate to it"
write_active "$IDLE"
if ! reload_caddy; then
  echo "::error::Caddy reload failed — reverting active file to usernode-$LIVE" >&2
  write_active "$LIVE"
  reload_caddy || true
  docker compose stop "usernode-$IDLE" >/dev/null 2>&1 || true
  exit 1
fi

# Traffic now flows to the new color. Drain + stop the old color. Its SIGTERM
# handler releases the leader advisory lock LAST (after draining), so the new
# color promotes itself to leader and runs recovery + sweepers once the old
# color is gone.
log "Cutover done — draining + stopping old color usernode-$LIVE (grace ${DRAIN_TIMEOUT}s)"
docker compose stop -t "$DRAIN_TIMEOUT" "usernode-$LIVE"

log "Rollout complete — live on usernode-$IDLE"
