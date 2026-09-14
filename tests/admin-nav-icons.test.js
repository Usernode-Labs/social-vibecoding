// Every admin menu section carries an icon (#1862).
//
// Both menu renderers (the desktop sidebar and the phone level-1 menu) read
// AdminConsole.NAV_ICONS[s.key] and fall back to '' — so a section added
// without an icon renders as a bare label, misaligned against every other
// row, and nothing else notices. "E2E coverage" shipped that way. This pins
// the pairing at the source: each SECTIONS key has an NAV_ICONS entry, and
// every icon uses the same inline Heroicons treatment as its siblings.
//
// Run with: node --test tests/admin-nav-icons.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'admin', 'admin-console.js'),
  'utf8',
);

const SECTION_KEYS = [...SRC.matchAll(/\{ key: '([^']+)', label: '[^']+', group: '[^']+' \}/g)]
  .map((m) => m[1]);

const iconsStart = SRC.indexOf('NAV_ICONS: Object.freeze({');
const iconsEnd = SRC.indexOf('}),', iconsStart);
const ICONS_SRC = SRC.slice(iconsStart, iconsEnd);
const ICONS = new Map(
  [...ICONS_SRC.matchAll(/^\s+'([^']+)': '(<svg[^']*<\/svg>)',$/gm)].map((m) => [m[1], m[2]]),
);

test('the section list and the icon table were both found', () => {
  assert.ok(SECTION_KEYS.length > 20, `found ${SECTION_KEYS.length} sections`);
  assert.ok(iconsStart > 0 && iconsEnd > iconsStart, 'NAV_ICONS block located');
  assert.ok(ICONS.size > 20, `found ${ICONS.size} icons`);
});

test('every admin section has a menu icon', () => {
  const missing = SECTION_KEYS.filter((k) => !ICONS.has(k));
  assert.deepEqual(missing, [], `sections without a NAV_ICONS entry: ${missing.join(', ')}`);
});

test('E2E coverage has its icon', () => {
  assert.ok(SECTION_KEYS.includes('e2e'));
  assert.ok(ICONS.has('e2e'));
});

test('every icon uses the shared outline treatment', () => {
  for (const [key, svg] of ICONS) {
    assert.ok(
      svg.startsWith('<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">'),
      `${key} icon diverges from the shared svg attributes`,
    );
  }
});
