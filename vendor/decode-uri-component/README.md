# CommonJS adaptation of decode-uri-component 0.5.1

This is the upstream MIT-licensed 0.5.1 decoder, including the fixes for
CVE-2026-118664 and CVE-2026-45822. Only the export declaration changes:
`export default function decodeUriComponent` becomes
`module.exports = function decodeUriComponent`. The algorithm is unchanged.

MinIO 8 uses query-string 7, which calls the decoder as a CommonJS function.
The registry's 0.5.1 package is ESM. This local package preserves that call
contract without replacing the storage client or shipping the vulnerable
0.2.2 implementation. Its version is `0.5.1+homeroom.cjs.1` to identify the
upstream algorithm and the local packaging change. The root dependency and
override make every installed decoder resolve to these reviewed bytes.

Upstream sources:

- https://github.com/SamVerschueren/decode-uri-component/tree/v0.5.1
- https://registry.npmjs.org/decode-uri-component/-/decode-uri-component-0.5.1.tgz
- https://github.com/SamVerschueren/decode-uri-component/security/advisories/GHSA-qr28-fpjm-wq7f

SHA-256 of the registry package's original `index.js`:
`6a86ac891edf15c5efa0841ebb31935e3669d58b98318b57d7b08a4530317cb0`.

SHA-256 of this export-adapted `index.js`:
`e82696ecdf0ee2c25bd90169cc7915e552d2ccb82a5006c55bc17aecdb55b919`.

The regression suite verifies the reversible export-only adaptation, the
actual query-string resolution, malformed UTF-8 handling, the advisory's
large distinct-run payload under a child-process deadline, and MinIO URL
signing. Retire this local package when MinIO supports a patched decoder
natively and clean image scans and storage tests pass.
