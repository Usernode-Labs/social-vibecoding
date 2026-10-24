#!/bin/sh
set -eu
image=$1
out=$2
mkdir -p "$(dirname "$out")"
archive_dir=$(mktemp -d)
trap 'rm -rf "$archive_dir"' EXIT HUP INT TERM
# The scanner receives one exported archive, never the Docker daemon socket.
docker image save -o "$archive_dir/image.tar" "$image"
docker run --rm --network none -e SYFT_CHECK_FOR_APP_UPDATE=false -v "$archive_dir/image.tar:/image.tar:ro" \
  anchore/syft:v1.55.0 docker-archive:/image.tar -o spdx-json > "$out"
