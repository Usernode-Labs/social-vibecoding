#!/usr/bin/env bash
set -euo pipefail
out="$RUNNER_TEMP/worker-bench-result"
full="$RUNNER_TEMP/security-worker"
mkdir -p "$out" "$full"
unset BASELINE_IMAGE SECURITY_AUDIT_ONLY
started=$(date +%s)
route=build
reason=baseline
latest=
cache_image=$EXPERIMENT_IMAGE

record_failure() {
  local rc=$?
  if [[ "$rc" != 0 ]]; then
    printf 'Worker benchmark failed at %ss (route=%s, reason=%s)\n' "$(( $(date +%s) - started ))" "$route" "$reason" >&2
  fi
}
trap record_failure EXIT

fetch_evidence() {
  local p="$out/provenance.json"
  local source_tree current_tree materials base reference recorded
  source_tree="$(git rev-parse "$EXPERIMENT_SOURCE:worker")" || return 1
  current_tree="$(git rev-parse HEAD:worker)" || return 1
  if [[ "$source_tree" != "$current_tree" ]]; then
    reason=worker-context-changed
    return 1
  fi
  latest="$(npm view @anthropic-ai/claude-code@latest version)" || return 1
  [[ "$latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  if [[ -z "${candidate_image:-}" ]]; then
    reason=missing-evidence
    return 1
  fi

  # This is an experiment. BuildKit records the base images and declared
  # inputs but does not attest to all files downloaded by apt/npm in RUN.
  docker buildx imagetools inspect "$candidate_image" --format '{{json .Provenance}}' > "$p" || return 1
  jq -e --arg rev "$EXPERIMENT_SOURCE" --arg version "$latest" '
    .SLSA.buildDefinition.externalParameters.request.root.request.args as $args
    | $args["vcs:source"] == "https://github.com/Usernode-Labs/social-vibecoding"
      and $args["vcs:revision"] == $rev
      and $args["vcs:localdir:context"] == "worker"
      and $args["vcs:localdir:dockerfile"] == "worker"
      and $args["build-arg:CLAUDE_CODE_VERSION"] == $version
      and ([$args | keys[] | select(startswith("build-arg:"))] == ["build-arg:CLAUDE_CODE_VERSION"])
  ' "$p" >/dev/null || { reason=provenance-mismatch; return 1; }

  materials="$(jq -c '.SLSA.buildDefinition.resolvedDependencies' "$p")" || return 1
  while read -r base; do
    reference="$(docker buildx imagetools inspect "mirror.gcr.io/library/$base" --format '{{.Manifest.Digest}}')" || return 1
    recorded="$(jq -er --arg uri "pkg:docker/${base/:/@}?platform=linux%2Famd64" '.[] | select(.uri == $uri) | .digest.sha256' <<<"$materials")" || return 1
    [[ "$reference" == "sha256:$recorded" ]] || { reason=base-digest-changed; return 1; }
  done < <(awk '/^FROM / {print $2}' worker/Dockerfile)
  reason=matching-attested-inputs
}

live_output="$RUNNER_TEMP/worker-bench-live"
GITHUB_OUTPUT="$live_output" node scripts/live-release.js
test "$(sed -n 's/^worker=//p' "$live_output")" = "${cache_image##*@}"

if [[ "$BENCHMARK_MODE" != baseline ]]; then
  git fetch --no-tags --depth=1 origin "$EXPERIMENT_SOURCE"
  candidate_image=$EXPERIMENT_IMAGE
  [[ "$BENCHMARK_MODE" != missing ]] || candidate_image=
  reason=evidence-unavailable
  if fetch_evidence; then
    if [[ "$BENCHMARK_MODE" == digest ]]; then
      route=digest
    elif [[ "$BENCHMARK_MODE" == layers ]]; then
      route=layers
    fi
  fi
fi

case "$BENCHMARK_MODE" in
  digest|layers) [[ "$route" == "$BENCHMARK_MODE" ]];;
  changed) [[ "$route:$reason" == build:worker-context-changed ]];;
  missing) [[ "$route:$reason" == build:missing-evidence ]];;
esac

selection_seconds=$(( $(date +%s) - started ))
echo "BENCH_SELECTION mode=$BENCHMARK_MODE route=$route reason=$reason seconds=$selection_seconds"
acquired_started=$(date +%s)
if [[ "$route" == digest ]]; then
  docker pull --platform linux/amd64 "$EXPERIMENT_IMAGE"
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$EXPERIMENT_IMAGE" | grep -Fx "$EXPERIMENT_IMAGE"
  docker tag "$EXPERIMENT_IMAGE" security-worker
else
  build_args=(--load --pull --platform linux/amd64 -t security-worker -f worker/Dockerfile
    --cache-from "type=registry,ref=$cache_image")
  if [[ "$route" == layers ]]; then
    build_args+=(--build-arg "CLAUDE_CODE_VERSION=$latest")
  fi
  docker buildx build "${build_args[@]}" worker
fi
acquisition_seconds=$(( $(date +%s) - acquired_started ))
echo "BENCH_ACQUIRE mode=$BENCHMARK_MODE route=$route seconds=$acquisition_seconds"

inventory_started=$(date +%s)
sh scripts/create-image-sbom.sh security-worker "$full/sbom.spdx.json"
inventory_seconds=$(( $(date +%s) - inventory_started ))
scan_started=$(date +%s)
scan_result=0
sh scripts/check-image-security.sh security-worker "$full" "$full/sbom.spdx.json" worker || scan_result=$?
scan_seconds=$(( $(date +%s) - scan_started ))
elapsed=$(( $(date +%s) - started ))
echo "BENCH_RESULT mode=$BENCHMARK_MODE route=$route seconds=$elapsed scan_exit=$scan_result"
jq -n --arg mode "$BENCHMARK_MODE" --arg route "$route" --arg reason "$reason" \
  --argjson elapsed "$elapsed" --argjson selection "$selection_seconds" --argjson acquisition "$acquisition_seconds" \
  --argjson inventory "$inventory_seconds" --argjson scan "$scan_seconds" --argjson scan_exit "$scan_result" \
  '{mode:$mode,route:$route,reason:$reason,elapsed:$elapsed,selection:$selection,acquisition:$acquisition,inventory:$inventory,scan:$scan,scan_exit:$scan_exit}' > "$out/timing.json"
node -e '
  const fs = require("node:fs");
  const { sbomPackages } = require("./scripts/security-findings");
  const packages = sbomPackages(JSON.parse(fs.readFileSync(process.argv[1])));
  process.stdout.write(JSON.stringify([...packages].sort()));
' "$full/sbom.spdx.json" > "$out/packages.json"
docker image inspect security-worker --format '{{json .RootFS.Layers}}' > "$out/rootfs.json"
for evidence in assessment.json runtime.json npm-inventory.json playwright-browsers.json image-vulnerabilities.json vulnerabilities.json browser-vulnerabilities.json; do
  if [[ -s "$full/$evidence" ]]; then cp "$full/$evidence" "$out"; fi
done
rm -f "$out/provenance.json"
exit "$scan_result"
