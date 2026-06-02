#!/usr/bin/env bash
#
# capacity-probe.sh — measure the real per-worker footprint and estimate
# how many concurrent dev sessions this box can hold.
#
# WHY: the docker `--memory` ceiling (WORKER_MEMORY, e.g. 2g) is a LIMIT,
# not a reservation. A warm/idle worker holds only its sleep-wrapper RSS;
# the RAM spike happens during an *active turn* (docker exec run-cc.sh).
# So "will 50 users fit" really means "how many concurrent active turns
# fit", which is gated by MAX_GLOBAL_SESSIONS. This script measures the
# idle floor with the real image + real limits, then prints a ceiling
# estimate so you can size MAX_GLOBAL_SESSIONS to the host.
#
# It does NOT call the LLM or touch the app — it just launches probe
# containers from the worker image and reads `docker stats`. Safe to run
# on prod (probes are named usernode-capacity-probe-* and torn down at the
# end, including on Ctrl-C).
#
# Usage:
#   scripts/capacity-probe.sh [N] [RESERVE_GB]
#     N           how many probe containers to launch (default 10)
#     RESERVE_GB  RAM to hold back for platform+db+node+caddy+OS
#                 (default 16)
#
# Env (mirror your prod .env so the probe uses the same limits):
#   WORKER_IMAGE   default usernode-worker:latest
#   WORKER_MEMORY  default 2g
#   WORKER_CPUS    default 2
#   PEAK_TURN_MB   measured peak RSS of one ACTIVE turn, if you have it.
#                  When set, the ceiling is computed from this instead of
#                  the idle floor (far more accurate). See the note the
#                  script prints on how to measure it.

set -euo pipefail

N="${1:-10}"
RESERVE_GB="${2:-16}"
WORKER_IMAGE="${WORKER_IMAGE:-usernode-worker:latest}"
WORKER_MEMORY="${WORKER_MEMORY:-2g}"
WORKER_CPUS="${WORKER_CPUS:-2}"
PREFIX="usernode-capacity-probe"

cleanup() {
  echo
  echo "Cleaning up probe containers..."
  ids="$(docker ps -aq --filter "name=^/${PREFIX}-" 2>/dev/null || true)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
  echo "Done."
}
trap cleanup EXIT INT TERM

echo "== Capacity probe =="
echo "image=${WORKER_IMAGE}  mem_limit=${WORKER_MEMORY}  cpus=${WORKER_CPUS}  N=${N}  reserve=${RESERVE_GB}GB"
echo

if ! docker image inspect "$WORKER_IMAGE" >/dev/null 2>&1; then
  echo "ERROR: image '$WORKER_IMAGE' not found locally. Build it first (the"
  echo "       server does this via worker.buildImage at boot) or set WORKER_IMAGE."
  exit 1
fi

echo "Launching ${N} idle probe containers..."
for i in $(seq 1 "$N"); do
  docker run -d --name "${PREFIX}-${i}" \
    --memory "$WORKER_MEMORY" --cpus "$WORKER_CPUS" \
    --entrypoint sh "$WORKER_IMAGE" -c 'sleep 86400' >/dev/null
done

# Let them settle so RSS isn't measured mid-startup.
sleep 3

echo
echo "Per-probe stats (idle floor):"
docker stats --no-stream \
  --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' \
  $(docker ps -q --filter "name=^/${PREFIX}-")

# Sum idle RSS in MB by parsing "123.4MiB / 2GiB" -> 123.4 (MiB≈MB here).
total_mb="$(docker stats --no-stream --format '{{.MemUsage}}' \
  $(docker ps -q --filter "name=^/${PREFIX}-") \
  | awk '{
      v=$1;
      unit=v; sub(/[0-9.]+/,"",unit);
      num=v; sub(/[A-Za-z]+$/,"",num);
      if (unit ~ /GiB/) num*=1024;
      else if (unit ~ /KiB/) num/=1024;
      sum+=num;
    } END { printf "%.1f", sum }')"

avg_mb="$(awk -v t="$total_mb" -v n="$N" 'BEGIN{ printf "%.1f", (n>0? t/n : 0) }')"

# Host RAM total in MB (Linux: /proc/meminfo; macOS: sysctl).
if [ -r /proc/meminfo ]; then
  host_mb="$(awk '/MemTotal/ {printf "%.0f", $2/1024}' /proc/meminfo)"
else
  host_mb="$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f", $1/1024/1024}')"
fi
reserve_mb=$(( RESERVE_GB * 1024 ))
usable_mb=$(( host_mb - reserve_mb ))

echo
echo "== Measurements =="
printf "  idle RSS: total=%s MB across %s probes  (avg %s MB/worker)\n" "$total_mb" "$N" "$avg_mb"
printf "  host RAM: %s MB total, reserving %s MB -> %s MB usable for workers+staging\n" "$host_mb" "$reserve_mb" "$usable_mb"

echo
echo "== Ceiling estimate =="
if [ -n "${PEAK_TURN_MB:-}" ]; then
  fit="$(awk -v u="$usable_mb" -v p="$PEAK_TURN_MB" 'BEGIN{ printf "%d", (p>0? u/p : 0) }')"
  echo "  Using PEAK_TURN_MB=${PEAK_TURN_MB} (measured active-turn RSS):"
  echo "    ~${fit} concurrent ACTIVE turns fit -> set MAX_GLOBAL_SESSIONS near this."
else
  fit_idle="$(awk -v u="$usable_mb" -v a="$avg_mb" 'BEGIN{ printf "%d", (a>0? u/a : 0) }')"
  echo "  Idle-floor only (OPTIMISTIC — real turns use much more):"
  echo "    ~${fit_idle} idle workers fit, but active turns are the real limit."
  echo
  echo "  To get an accurate ceiling, measure a real active turn:"
  echo "    1) fire a few concurrent chat turns on a test app,"
  echo "    2) watch:  docker stats --format '{{.Name}}\\t{{.MemUsage}}'  | grep usernode-worker-"
  echo "    3) take the PEAK MemUsage of one worker mid-turn (MB),"
  echo "    4) re-run:  PEAK_TURN_MB=<that> scripts/capacity-probe.sh ${N} ${RESERVE_GB}"
fi
echo
echo "Note: staging containers + per-app prod stacks also draw on the same"
echo "      usable pool — subtract their footprint, or raise RESERVE_GB."
