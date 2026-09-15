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
  return [...SRC.matchAll(/\{ key: '([a-z0-9-]+)', label: '[^']+', group: '[A-Za-z]+'[^}]*\}/g)]
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
  assert.ok(sections.includes('status') && sections.includes('e2e'), `found ${sections.length} sections`);
  const icons = new Set(iconKeys());
  assert.deepEqual(sections.filter((k) => !icons.has(k)), []);
});

test('E2E coverage has its icon (#1862)', () => {
  assert.ok(iconKeys().includes('e2e'));
});
