#!/bin/sh
set -eu
out=${1:?worker assessment directory required}
shift
layout=$(mktemp -d)
db_pid=
finish() {
  result=$?
  [ -z "$db_pid" ] || wait "$db_pid" || true
  rm -rf "$layout"
  exit "$result"
}
trap finish EXIT

# Fetch the advisory database while the fresh worker image builds.
docker run --rm -v social-security-trivy-db:/root/.cache/trivy \
  aquasec/trivy:0.76.1 image --download-db-only &
db_pid=$!
docker buildx build --provenance=false --sbom=false \
  --output "type=oci,tar=false,dest=$layout,name=security-worker" "$@"
wait "$db_pid"
db_pid=

SECURITY_TRIVY_DB_READY=1 sh scripts/check-image-security.sh \
  security-worker "$out" "$out/sbom.spdx.json" worker "$layout"
