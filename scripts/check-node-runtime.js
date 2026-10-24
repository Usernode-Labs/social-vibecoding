'use strict';
// Run this inside the finished image (also safe to pass to `node` on stdin).
function supported(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!m && Number(m[1]) === 22 && (Number(m[2]) > 23 || (Number(m[2]) === 23 && Number(m[3]) >= 4));
}
if (!module.parent) {
  console.log(JSON.stringify({ node: process.version, brotli: process.versions.brotli,
    openssl: process.versions.openssl, arch: process.arch, platform: process.platform }));
  if (!supported(process.version)) { console.error('Image requires Node 22 >= 22.23.4'); process.exitCode = 1; }
}
module.exports = { supported };
