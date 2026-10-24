#!/bin/sh
set -eu
image=$1
out=$2
component=$3
mkdir -p "$out"
printf '%s\n' "$image" > "$out/image-reference.txt"
docker buildx imagetools inspect "$image" --format '{{json .SBOM}}' > "$out/buildkit-sbom.json"
node - "$out/buildkit-sbom.json" "$out/sbom.spdx.json" <<'NODE'
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sbom = input?.SPDX || input?.['linux/amd64']?.SPDX;
if (!sbom?.spdxVersion || !sbom.packages?.length) throw new Error('Missing BuildKit SPDX attestation');
fs.writeFileSync(process.argv[3], JSON.stringify(sbom));
NODE
sh scripts/check-image-security.sh "$image" "$out" "$out/sbom.spdx.json" "$component"
