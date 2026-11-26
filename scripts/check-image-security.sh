#!/bin/sh
set -eu
image=$1
out=$2
component=${4:?image component required}
layout=${5:-}
mkdir -p "$out"
phase='image inventory'
assessment_done=0
archive_dir=
db_pid=
inventory_pid=
image_scan_pid=
image_load_pid=
finish() {
  result=$?
  if [ "$assessment_done" != 1 ]; then
    node scripts/security-findings.js --unavailable "$out" "$component" "$phase failed; retry or review this assessment" || true
    [ "$result" != 0 ] || result=1
  fi
  for pid in "$db_pid" "$inventory_pid" "$image_scan_pid" "$image_load_pid"; do
    [ -z "$pid" ] || wait "$pid" || true
  done
  [ -z "$archive_dir" ] || rm -rf "$archive_dir"
  exit "$result"
}
trap finish EXIT
rm -f "$out/assessment.json" "$out/vulnerabilities.json" "$out/image-vulnerabilities.json" \
  "$out/playwright-browsers.json" "$out/playwright-browser-query.cdx.json" \
  "$out/playwright-browser-advisories.json" "$out/browser-vulnerabilities.json"
printf '%s\n' "$image" > "$out/image-reference.txt"
if [ -z "$layout" ]; then
  case "$image" in
    *@sha256:*) ;;
    *) docker image inspect --format '{{.Id}}' "$image" > "$out/image-reference.txt" ;;
  esac
fi
# The release pipeline passes BuildKit's attached SPDX SBOM, covering OS and
# global tools as well as lockfile packages. Local builds may pass a Syft SBOM.
sbom=$3
[ -n "$layout" ] || test -s "$sbom"

# BASELINE_IMAGE (the live image of this component, by digest) makes the gate
# block only what this image introduces: a finding on a package the live image
# already ships at the same version is reported, not failed.
#
# An image with the live image's own digest is the live image: nothing in it
# can be introduced, so it is not pulled for the runtime probes or saved for
# the full-image scan. Those two hold the image twice on the runner's disk,
# and the worker image filled it (31 Oct 2026, the release for #6072, whose
# worker image was the live one, reused). Its SBOM is the live SBOM, so the
# SBOM scan still runs for the record, against itself.
digest_of() {
  case "$1" in *@sha256:*) printf '%s\n' "${1##*@}" ;; *) printf '\n' ;; esac
}
live=
if [ -n "${BASELINE_IMAGE:-}" ] && [ -n "$(digest_of "$image")" ] \
  && [ "$(digest_of "$image")" = "$(digest_of "$BASELINE_IMAGE")" ]; then
  live=1
fi

# Fetch the public database without project files while the runner pulls
# and probes the exact image. Wait before any offline scanner opens the DB.
if [ -z "$layout" ] && [ -n "${SECURITY_TRIVY_DB_CONTAINER:-}" ]; then
  # The release job started this download while the image built. `docker wait`
  # prints its exit code; anything but 0 is a database that was not fetched.
  (
    code=$(docker wait "$SECURITY_TRIVY_DB_CONTAINER")
    [ "$code" = 0 ] || { docker logs "$SECURITY_TRIVY_DB_CONTAINER" 2>&1 | tail -n 20; exit 1; }
  ) &
  db_pid=$!
elif [ -z "$layout" ]; then
  docker run --rm -v social-security-trivy-db:/root/.cache/trivy \
    aquasec/trivy:0.76.1 image --download-db-only &
  db_pid=$!
else
  phase='prepare shared scan input'
  test "$component" = worker
  test -z "$live"
  test "${SECURITY_TRIVY_DB_READY:-}" = 1
  manifest=$(jq -er '.manifests | select(length == 1) | .[0].digest | select(test("^sha256:[0-9a-f]{64}$"))' "$layout/index.json")
  config=$(jq -er '.config.digest | select(test("^sha256:[0-9a-f]{64}$"))' "$layout/blobs/sha256/${manifest#sha256:}")
  jq -e '.os == "linux" and .architecture == "amd64"' "$layout/blobs/sha256/${config#sha256:}" >/dev/null

  # Both scanners read this layout while Docker imports it for the probes.
  # Docker can report the manifest or the config digest as the loaded ID.
  bash -eo pipefail -c '
    tar -C "$1" -cf - . | docker image load
    actual="$(docker image inspect --format "{{.Id}}" "$2")"
    [[ "$actual" == "$3" || "$actual" == "$4" ]]
  ' _ "$layout" "$image" "$manifest" "$config" &
  image_load_pid=$!
  docker run --rm --network none -e SYFT_CHECK_FOR_APP_UPDATE=false -v "$layout:/image:ro" \
    anchore/syft:v1.55.0 oci-dir:/image -o spdx-json > "$sbom" &
  inventory_pid=$!
  docker run --rm --network none -v "$layout:/image:ro" \
    -v "$(cd "$out" && pwd):/output" -v social-security-trivy-db:/root/.cache/trivy \
    aquasec/trivy:0.76.1 image --skip-db-update --offline-scan --cache-backend memory \
    --input /image --scanners vuln --format json --output /output/image-vulnerabilities.json &
  image_scan_pid=$!
fi

if [ -n "$image_load_pid" ]; then
  phase='OCI runtime image import'
  wait "$image_load_pid"
  image_load_pid=
  docker image inspect --format '{{.Id}}' "$image" > "$out/image-reference.txt"
fi

if [ -z "$live" ]; then
  phase='runtime probes'
  # No app command, network or production credentials are used by these probes.
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$image" < scripts/check-node-runtime.js > "$out/runtime.json"
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$image" < scripts/image-npm-inventory.js > "$out/npm-inventory.json"
  # The Chromium builds Playwright downloaded: no scanner below can see them.
  phase='Playwright browser inventory'
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$image" < scripts/playwright-browsers-inventory.js > "$out/playwright-browsers.json"
fi
if [ -n "$db_pid" ]; then
  phase='vulnerability database download'
  wait "$db_pid"
  db_pid=
fi
if [ -n "$inventory_pid" ]; then
  phase='image inventory'
  wait "$inventory_pid"
  inventory_pid=
  test -s "$sbom"
fi
# Keep complete reports, including unfixed and lower-severity findings.
phase='SBOM scan'
docker run --rm --network none -v "$(cd "$(dirname "$sbom")" && pwd):/input:ro" \
  -v "$(cd "$out" && pwd):/output" -v social-security-trivy-db:/root/.cache/trivy \
  aquasec/trivy:0.76.1 sbom --skip-db-update --offline-scan --cache-backend memory \
  --scanners vuln --format json --output /output/vulnerabilities.json \
  "/input/$(basename "$sbom")"
test -s "$out/vulnerabilities.json"
if [ -n "$image_scan_pid" ]; then
  phase='full-image scan'
  wait "$image_scan_pid"
  image_scan_pid=
  test -s "$out/image-vulnerabilities.json"
elif [ -z "$live" ]; then
  phase='image archive'
  # A third-party SPDX document can lose distro metadata. Scan the actual
  # image too, independently of the complete global-npm SBOM inventory.
  archive_dir=$(mktemp -d)
  started=$(date +%s)
  docker image save -o "$archive_dir/image.tar" "$image"
  echo "Image archive saved in $(( $(date +%s) - started ))s"
  phase='full-image scan'
  started=$(date +%s)
  docker run --rm --network none -v "$archive_dir/image.tar:/image.tar:ro" \
    -v "$(cd "$out" && pwd):/output" -v social-security-trivy-db:/root/.cache/trivy \
    aquasec/trivy:0.76.1 image --skip-db-update --offline-scan --cache-backend memory \
    --input /image.tar --scanners vuln --format json --output /output/image-vulnerabilities.json
  test -s "$out/image-vulnerabilities.json"
  echo "Full-image scan completed in $(( $(date +%s) - started ))s"
  rm -rf "$archive_dir"
  archive_dir=
fi
# Each Playwright browser against every Chromium advisory in the same offline
# database, judged by the Chrome release that fixed it
# (scripts/playwright-browser-findings.js). A browser whose version cannot be
# read fails this phase: the assessment is unavailable, never clean.
if [ -s "$out/playwright-browsers.json" ]; then
  phase='Playwright browser scan'
  browsers=$(node scripts/playwright-browser-findings.js --query "$out/playwright-browsers.json" "$out/playwright-browser-query.cdx.json")
  if [ "$browsers" != 0 ]; then
    docker run --rm --network none -v "$(cd "$out" && pwd):/output" -v social-security-trivy-db:/root/.cache/trivy \
      aquasec/trivy:0.76.1 sbom --skip-db-update --offline-scan --cache-backend memory \
      --scanners vuln --format json --output /output/playwright-browser-advisories.json \
      /output/playwright-browser-query.cdx.json
    node scripts/playwright-browser-findings.js --report "$out/playwright-browsers.json" \
      "$out/playwright-browser-advisories.json" "$out/browser-vulnerabilities.json"
  fi
fi

baseline=
baseline_name=
phase='scan validation'
potential=$(node scripts/security-findings.js --potential "$out" "$component")
if [ "${SECURITY_AUDIT_ONLY:-}" = 1 ]; then
  : # A full audit records findings independently of a release decision.
elif [ "$potential" = 0 ]; then
  : # A clean candidate needs no second image build or baseline lookup.
elif [ -n "${SECURITY_BASELINE_REVISION:-}" ]; then
  phase='PR-base inventory generation'
  baseline="$out/baseline-sbom.spdx.json"
  node scripts/security-image-baseline.js "$component" "$SECURITY_BASELINE_REVISION" "$baseline"
  baseline_name="PR base $SECURITY_BASELINE_REVISION"
elif [ -n "$live" ]; then
  printf '%s\n' "$BASELINE_IMAGE" > "$out/baseline-image-reference.txt"
  baseline="$sbom"
  baseline_name='the recorded release image'
  note="Same digest as the live image ($(digest_of "$image")): the runtime probes and the full-image scan are skipped, since nothing in it can be introduced by this release. The SBOM scan ran for the record."
  printf '%s\n' "$note" > "$out/live-image.txt"
  echo "::notice title=$component image is the live image::$note"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### %s image\n\n%s\n\n' "$component" "$note" >> "$GITHUB_STEP_SUMMARY"
  fi
elif [ -n "${BASELINE_IMAGE:-}" ]; then
  # Reading the live image's SBOM attestation pulls no layers. Unreadable,
  # a failed comparison is unavailable, not a newly introduced vulnerability.
  phase='release baseline retrieval'
  if docker buildx imagetools inspect "$BASELINE_IMAGE" --format '{{json .SBOM}}' > "$out/baseline-buildkit-sbom.json" \
    && node scripts/image-spdx.js "$out/baseline-buildkit-sbom.json" "$out/baseline-sbom.spdx.json"; then
    printf '%s\n' "$BASELINE_IMAGE" > "$out/baseline-image-reference.txt"
    baseline="$out/baseline-sbom.spdx.json"
    baseline_name='the recorded release image'
  else
    exit 2
  fi
else
  phase='baseline unavailable'
  exit 2
fi
phase='assessment'
status=0
node scripts/security-findings.js --assess "$out" "$component" "$baseline" "$baseline_name" || status=$?
if [ -s "$out/assessment.json" ]; then assessment_done=1; fi
exit "$status"
