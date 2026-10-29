'use strict';
// Extract the SPDX document from `docker buildx imagetools inspect --format
// '{{json .SBOM}}'` output (BuildKit's attestation, single- or multi-platform).
// usage: image-spdx.js <buildkit-sbom.json> <out.spdx.json>
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sbom = input?.SPDX || input?.['linux/amd64']?.SPDX;
if (!sbom?.spdxVersion || !sbom.packages?.length) throw new Error('Missing BuildKit SPDX attestation');
fs.writeFileSync(process.argv[3], JSON.stringify(sbom));
