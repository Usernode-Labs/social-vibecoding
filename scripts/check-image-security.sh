#!/bin/sh
set -eu
image=$1
out=$2
component=${4:?image component required}
mkdir -p "$out"
# The release pipeline passes BuildKit's attached SPDX SBOM, covering OS and
# global tools as well as lockfile packages. Local builds may pass a Syft SBOM.
sbom=$3
test -s "$sbom"

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

if [ -z "$live" ]; then
  # No app command, network or production credentials are used by these probes.
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$image" < scripts/check-node-runtime.js > "$out/runtime.json"
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$image" < scripts/image-npm-inventory.js > "$out/npm-inventory.json"
fi
# Download the public database in a container that sees no project files.
# Scanners that receive the SBOM or image archive have networking disabled.
docker run --rm -v social-security-trivy-db:/root/.cache/trivy \
  aquasec/trivy:0.76.1 image --download-db-only
# Keep complete reports, including unfixed and lower-severity findings.
docker run --rm --network none -v "$(cd "$(dirname "$sbom")" && pwd):/input:ro" \
  -v "$(cd "$out" && pwd):/output" -v social-security-trivy-db:/root/.cache/trivy \
  aquasec/trivy:0.76.1 sbom --skip-db-update --offline-scan --cache-backend memory \
  --scanners vuln --format json --output /output/vulnerabilities.json \
  "/input/$(basename "$sbom")"
if [ -z "$live" ]; then
  # A third-party SPDX document can lose distro metadata. Scan the actual
  # image too, independently of the complete global-npm SBOM inventory.
  archive_dir=$(mktemp -d)
  trap 'rm -rf "$archive_dir"' EXIT HUP INT TERM
  docker image save -o "$archive_dir/image.tar" "$image"
  docker run --rm --network none -v "$archive_dir/image.tar:/image.tar:ro" \
    -v "$(cd "$out" && pwd):/output" -v social-security-trivy-db:/root/.cache/trivy \
    aquasec/trivy:0.76.1 image --skip-db-update --offline-scan --cache-backend memory \
    --input /image.tar --scanners vuln --format json --output /output/image-vulnerabilities.json
fi

baseline=
if [ -n "$live" ]; then
  printf '%s\n' "$BASELINE_IMAGE" > "$out/baseline-image-reference.txt"
  baseline="$sbom"
  note="Same digest as the live image ($(digest_of "$image")): the runtime probes and the full-image scan are skipped, since nothing in it can be introduced by this release. The SBOM scan ran for the record."
  printf '%s\n' "$note" > "$out/live-image.txt"
  echo "::notice title=$component image is the live image::$note"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### %s image\n\n%s\n\n' "$component" "$note" >> "$GITHUB_STEP_SUMMARY"
  fi
elif [ -n "${BASELINE_IMAGE:-}" ]; then
  # Reading the live image's SBOM attestation pulls no layers. Unreadable,
  # every finding blocks.
  if docker buildx imagetools inspect "$BASELINE_IMAGE" --format '{{json .SBOM}}' > "$out/baseline-buildkit-sbom.json" \
    && node scripts/image-spdx.js "$out/baseline-buildkit-sbom.json" "$out/baseline-sbom.spdx.json"; then
    printf '%s\n' "$BASELINE_IMAGE" > "$out/baseline-image-reference.txt"
    baseline="$out/baseline-sbom.spdx.json"
  else
    echo "::warning title=$component image::The live image's SBOM could not be read; every finding blocks."
  fi
fi
status=0
node scripts/security-findings.js "$out/vulnerabilities.json" "$component" $baseline || status=1
if [ -z "$live" ]; then
  node scripts/security-findings.js "$out/image-vulnerabilities.json" "$component" $baseline || status=1
fi
exit "$status"
