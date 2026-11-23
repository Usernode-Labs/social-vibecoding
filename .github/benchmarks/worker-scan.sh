#!/usr/bin/env bash
set -euo pipefail
out="$RUNNER_TEMP/worker-scan-result"
full="$RUNNER_TEMP/security-worker"
source_dir="$RUNNER_TEMP/worker-source/worker"
layout=
db_pid=
mkdir -p "$out" "$full"
unset BASELINE_IMAGE SECURITY_AUDIT_ONLY SECURITY_TRIVY_DB_READY
started=$(date +%s)
finish() {
  local rc=$?
  if [[ -n "$db_pid" ]]; then wait "$db_pid" || true; fi
  if [[ "$rc" != 0 ]]; then
    printf 'Worker scan benchmark failed at %ss in mode %s\n' "$(( $(date +%s) - started ))" "$BENCHMARK_MODE" >&2
  fi
}
trap finish EXIT

live_output="$RUNNER_TEMP/worker-scan-live"
GITHUB_OUTPUT="$live_output" node scripts/live-release.js
release_digest="$(sed -n 's/^worker=//p' "$live_output")"
[[ "$release_digest" =~ ^sha256:[0-9a-f]{64}$ ]]
cache_image="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/social-vibecoding-worker@$release_digest"

# The alternate paths use exactly the same latest Trivy DB, prepared
# independently of the worker build. The baseline does this inside the scan.
if [[ "$BENCHMARK_MODE" != standard ]]; then
  docker run --rm -v social-security-trivy-db:/root/.cache/trivy \
    aquasec/trivy:0.76.1 image --download-db-only &
  db_pid=$!
fi

build_args=(--pull --platform linux/amd64 -t security-worker -f "$source_dir/Dockerfile"
  --cache-from "type=registry,ref=$cache_image")
if [[ "$BENCHMARK_MODE" == oci ]]; then
  layout="$RUNNER_TEMP/worker-image-layout"
  mkdir -p "$layout"
  build_args+=(--provenance=false --sbom=false --output "type=oci,tar=false,dest=$layout,name=security-worker")
else
  build_args+=(--load)
fi

acquire_started=$(date +%s)
docker buildx build "${build_args[@]}" "$source_dir"
acquisition_seconds=$(( $(date +%s) - acquire_started ))
echo "BENCH_ACQUIRE mode=$BENCHMARK_MODE seconds=$acquisition_seconds cache=$cache_image"
scan_started=$(date +%s)
scan_result=0

if [[ "$BENCHMARK_MODE" == standard ]]; then
  sh scripts/create-image-sbom.sh security-worker "$full/sbom.spdx.json"
  sh scripts/check-image-security.sh security-worker "$full" "$full/sbom.spdx.json" worker || scan_result=$?
else
  wait "$db_pid"
  db_pid=
  SECURITY_TRIVY_DB_READY=1 sh scripts/check-image-security.sh security-worker "$full" "$full/sbom.spdx.json" \
    worker "$BENCHMARK_MODE" "$layout" || scan_result=$?
fi

scan_seconds=$(( $(date +%s) - scan_started ))
elapsed=$(( $(date +%s) - started ))
echo "BENCH_RESULT mode=$BENCHMARK_MODE seconds=$elapsed scan_exit=$scan_result"
jq -n --arg mode "$BENCHMARK_MODE" --arg cache "$cache_image" \
  --argjson elapsed "$elapsed" --argjson acquisition "$acquisition_seconds" \
  --argjson scan "$scan_seconds" --argjson scan_exit "$scan_result" \
  '{mode:$mode,cache:$cache,elapsed:$elapsed,acquisition:$acquisition,scan:$scan,scan_exit:$scan_exit}' > "$out/timing.json"
for evidence in assessment.json runtime.json npm-inventory.json playwright-browsers.json image-vulnerabilities.json vulnerabilities.json browser-vulnerabilities.json; do
  if [[ -s "$full/$evidence" ]]; then cp "$full/$evidence" "$out"; fi
done
if [[ -s "$full/sbom.spdx.json" ]]; then
  node -e '
    const fs = require("node:fs");
    const { sbomPackages } = require("./scripts/security-findings");
    const packages = sbomPackages(JSON.parse(fs.readFileSync(process.argv[1])));
    process.stdout.write(JSON.stringify([...packages].sort()));
  ' "$full/sbom.spdx.json" > "$out/packages.json"
fi
if docker image inspect security-worker --format '{{json .RootFS.Layers}}' > "$out/rootfs.json"; then
  docker image inspect security-worker --format '{{.Id}}' > "$out/image-id.txt"
fi
exit "$scan_result"
