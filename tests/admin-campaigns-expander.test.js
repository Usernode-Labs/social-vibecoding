'use strict';

// Maintenance campaigns: a campaign's header is its expander, so it must be
// reachable and operable from the keyboard and announce whether it is open,
// the same as the console's other expanders (Merges' run-head, account
// deletions). Source-level pins, in the style of admin-users-details.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/admin/admin-campaigns.tsx'), 'utf8');

function toggleTag() {
  const i = SRC.indexOf('data-campaign-toggle=');
  assert.ok(i > 0, 'the header keeps its data-campaign-toggle hook');
  const start = SRC.lastIndexOf('<', i);
  const end = SRC.indexOf(')}>', i);
  return SRC.slice(start, end + 3);
}

test('the campaign header is a real button, so Enter and Space toggle it', () => {
  const tag = toggleTag();
  assert.match(tag, /^<button type="button"/, 'a native button, not a clickable div');
  assert.match(tag, /onClick=\{\(\) => onToggle\(c\.id\)\}/);
  assert.doesNotMatch(SRC, /<div[^>]*data-campaign-toggle/, 'no clickable div header remains');
});

test('the header says whether it is open and which region it controls', () => {
  const tag = toggleTag();
  assert.match(tag, /aria-expanded=\{open\}/);
  assert.match(tag, /aria-controls=\{detailId\}/);
  assert.match(SRC, /const detailId = `admin-campaign-\$\{c\.id\}-detail`;/);
  assert.match(SRC, /<div id=\{detailId\} className=\{`mt-2\$\{open \? '' : ' hidden'\}`\} data-campaign-detail=\{c\.id\}>/,
    'the controlled body carries that id and keeps its data-campaign-detail hook');
});

test('the button holds phrasing content only', () => {
  const start = SRC.indexOf('<button type="button" className="w-full text-left');
  const body = SRC.slice(start, SRC.indexOf('</button>', start));
  assert.doesNotMatch(body, /<div\b/, 'no block <div> inside the button');
});
