#!/bin/sh
set -eu
component=${1:?image component required}
out=${2:?assessment directory required}
shift 2
layout=$(mktemp -d)
db_pid=
finish() {
  result=$?
  [ -z "$db_pid" ] || wait "$db_pid" || true
  rm -rf "$layout"
  exit "$result"
}
trap finish EXIT

# Fetch the advisory database while the fresh image builds.
docker run --rm -v social-security-trivy-db:/root/.cache/trivy \
  aquasec/trivy:0.76.1 image --download-db-only &
db_pid=$!
# This layout stays on the runner. Preserve upstream blobs and skip compression
# for newly built layers before the scanners and Docker unpack them.
docker buildx build --provenance=false --sbom=false \
  --output "type=oci,tar=false,compression=uncompressed,dest=$layout,name=security-$component" "$@"
wait "$db_pid"
db_pid=

SECURITY_TRIVY_DB_READY=1 sh scripts/check-image-security.sh \
  "security-$component" "$out" "$out/sbom.spdx.json" "$component" "$layout"
