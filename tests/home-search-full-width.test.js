'use strict';

// #1951: the home search field was capped at max-w-xl (576px) and sat against
// the home column's left edge, so on anything wider than a phone it looked
// off-centre. It now spans the column, which is itself capped and centred —
// so the field is full-width on a phone and centred, edge to edge with the
// content below it, on a desktop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const HOME = read('frontend/src/features/home/index.tsx');
const CSS = read('public/css/app.css');

function wrapperClasses() {
  const m = HOME.match(/<div className="home-column px-3 pt-3 pb-2">\s*<div className="([^"]*)">\s*<SearchIcon/);
  assert.ok(m, 'the search field sits in a wrapper inside the bar\'s .home-column');
  return m[1].split(/\s+/);
}

test('the search field has no width cap of its own', () => {
  const classes = wrapperClasses();
  assert.ok(!classes.some((c) => /^max-w-/.test(c)), `no max-w-*, got "${classes.join(' ')}"`);
  assert.ok(classes.includes('w-full'), 'spans the column');
  assert.match(HOME, /id="home-search-input"[\s\S]{0,300}?className="w-full /, 'and the input fills it');
});

test('the column it spans is capped and centred', () => {
  const i = CSS.indexOf('\n.home-column {');
  assert.ok(i >= 0);
  const body = CSS.slice(i, CSS.indexOf('\n}', i));
  assert.match(body, /max-width: 64rem;/);
  assert.match(body, /margin-left: auto;/);
  assert.match(body, /margin-right: auto;/);
  // Same column as the content below, so the edges line up.
  assert.match(HOME, /<div id="home-body" className="home-column /);
});
