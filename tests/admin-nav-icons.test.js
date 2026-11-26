'use strict';

// #1862: every admin console section draws an icon in the nav. The render
// falls back to '' for a missing key, so a section added without one ships
// as a bare label and nothing else notices — this test is what does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'admin', 'admin-console.js'),
  'utf8'
);

function sectionKeys() {
  // A group's name may hold a space, an ampersand or a hyphen now
  // ("Delivery & sign-in", request 7224).
  return [...SRC.matchAll(/\{ key: '([a-z0-9-]+)', label: '[^']+', group: '[^']+'[^}]*\}/g)]
    .map((m) => m[1]);
}

function iconKeys() {
  const start = SRC.indexOf('NAV_ICONS: Object.freeze({');
  assert.ok(start > 0, 'NAV_ICONS is declared');
  const end = SRC.indexOf('}),', start);
  return [...SRC.slice(start, end).matchAll(/^\s*'([a-z0-9-]+)': '<svg/gm)].map((m) => m[1]);
}

test('every admin section has a nav icon', () => {
  const sections = sectionKeys();
  assert.ok(sections.includes('status') && sections.includes('sign-in'), `found ${sections.length} sections`);
  // Every entry of SECTIONS is read, whatever its group is called.
  assert.equal(sections.length, (SRC.match(/^\s*\{ key: '[a-z0-9-]+', label: /gm) || []).length);
  const icons = new Set(iconKeys());
  assert.deepEqual(sections.filter((k) => !icons.has(k)), []);
});

// E2E coverage was removed (request 7224): it is no section and has no icon,
// and an old link to it opens the dashboard.
test('E2E coverage is gone, and an old link to it opens the dashboard', () => {
  assert.ok(!sectionKeys().includes('e2e'), 'no section');
  assert.ok(!iconKeys().includes('e2e'), 'no icon left behind for it');
  const start = SRC.indexOf('LEGACY_SECTION_KEYS: {');
  assert.ok(start > 0, 'LEGACY_SECTION_KEYS is declared');
  assert.match(SRC.slice(start, SRC.indexOf('},', start)), /^\s*e2e: 'overview',$/m);
  assert.ok(sectionKeys().includes('overview') && iconKeys().includes('overview'), 'and the dashboard has its icon');
});
