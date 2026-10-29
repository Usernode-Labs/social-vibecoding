#!/bin/sh
set -eu
image=$1
out=$2
component=$3
mkdir -p "$out"
printf '%s\n' "$image" > "$out/image-reference.txt"
docker buildx imagetools inspect "$image" --format '{{json .SBOM}}' > "$out/buildkit-sbom.json"
node scripts/image-spdx.js "$out/buildkit-sbom.json" "$out/sbom.spdx.json"
sh scripts/check-image-security.sh "$image" "$out" "$out/sbom.spdx.json" "$component"
