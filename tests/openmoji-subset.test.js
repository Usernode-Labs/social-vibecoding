// The OpenMoji subset, and the two lists that must not drift apart.
//
// The illustrated icon tier (frontend/src/lib/openmoji.ts) falls back to the
// plain text emoji for anything it has not vendored, so a MISSING icon is
// harmless — it renders exactly what the shell rendered before. The failure
// mode that is NOT harmless is the reverse: a stem the renderer believes is
// vendored but the fetcher never downloaded, which renders a broken image on
// every paint of that tile. These tests pin the two lists to each other and to
// what is actually on disk.
//
// Run with: node --test tests/openmoji-subset.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** The quoted stems out of a `[...]` list in either file. */
function stemsIn(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `expected ${marker}`);
  const open = src.indexOf('[', at);
  const close = src.indexOf(']', open);
  return (src.slice(open, close).match(/'[0-9A-F-]+'/g) || [])
    .map((s) => s.replace(/'/g, ''))
    .sort();
}

test('the renderer and the vendor script list the same icons', () => {
  const lib = stemsIn(read('frontend/src/lib/openmoji.ts'), 'export const VENDORED');
  const vendor = stemsIn(read('scripts/vendor-assets.js'), 'const OPENMOJI_STEMS');
  assert.ok(lib.length >= 50, 'the subset is actually populated');
  assert.deepEqual(lib, vendor,
    'frontend/src/lib/openmoji.ts and scripts/vendor-assets.js must list the same stems — '
    + 'a stem the renderer claims but the script never fetches renders a broken image');
});

test('every listed icon is on disk', () => {
  // public/vendor/openmoji/ is a build output like the font beside it, so this
  // only asserts when a vendor run has happened — CI runs `npm run
  // vendor:assets` before the suite.
  const dir = path.join(root, 'public', 'vendor', 'openmoji');
  if (!fs.existsSync(dir)) return;
  const onDisk = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)));
  const listed = stemsIn(read('frontend/src/lib/openmoji.ts'), 'export const VENDORED');
  const missing = listed.filter((s) => !onDisk.has(s));
  assert.deepEqual(missing, [], `listed but not vendored: ${missing.join(', ')}`);
});

test('the FE0F rule is encoded, because OpenMoji drops it', () => {
  // 🏗️ is U+1F3D7 U+FE0F and its file is 1F3D7.svg. Keeping the variation
  // selector in the stem 404s every affected icon — which is how the first
  // version of this shipped and was caught by the vendor step's own guard.
  const lib = read('frontend/src/lib/openmoji.ts');
  assert.match(lib, /cp === 0xfe0f/, 'the resolver strips the variation selector');
  assert.doesNotMatch(lib, /'[0-9A-F]+-FE0F'/, 'no stem carries FE0F');
  assert.doesNotMatch(read('scripts/vendor-assets.js'), /'[0-9A-F]+-FE0F'/,
    'no fetched stem carries FE0F either');
  // ZWJ, by contrast, IS kept — the resolver must not strip everything.
  assert.doesNotMatch(lib, /cp === 0x200d/, 'ZWJ is kept: 1F469-200D-1F4BB is a real file');
});

test('the licence obligation is recorded', () => {
  // CC BY-SA 4.0 requires attribution, and requires any MODIFIED icon to ship
  // under the same licence. We ship them unmodified; the credit still has to
  // exist somewhere a reader can find it.
  const readme = read('public/vendor/README.md');
  assert.match(readme, /OpenMoji/, 'the vendor README names OpenMoji');
  assert.match(readme, /CC BY-SA 4\.0/, 'and states its licence');
});
